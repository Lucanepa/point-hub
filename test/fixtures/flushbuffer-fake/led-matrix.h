// Stand-in for hzeller's include/led-matrix.h, for test/flushbuffer-selftest.mjs: just the part of
// the API firmware/flushbuffer/flushbuffer.cc uses, with no GPIO and no refresh thread, so the
// driver's own logic (control files, governor, start and exit) runs on any Linux machine.
//
// Every SwapOnVSync appends one line to $FAKE_MATRIX_LOG:
//   frame b=<brightness the pixels were set at> set=<SetPixel calls> lit=<non-black ones> mixed=<0|1>
// `mixed` is 1 if the brightness changed while the frame was being drawn (it never should).
// Option parsing mirrors the real one where the driver depends on it: --led-* flags are consumed
// (unknown ones too, with the real warning), anything else is left in argv, and a brightness
// outside 1..100 fails creation the way Options::Validate does.

#ifndef FAKE_LED_MATRIX_H
#define FAKE_LED_MATRIX_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace rgb_matrix {

struct RuntimeOptions {
  RuntimeOptions() : gpio_slowdown(1) {}
  int gpio_slowdown;
};

class FrameCanvas {
public:
  explicit FrameCanvas(const uint8_t *brightness) : brightness_(brightness) { Reset(); }
  void Fill(uint8_t, uint8_t, uint8_t) { Reset(); }
  void SetPixel(int, int, uint8_t r, uint8_t g, uint8_t b) {
    if (set_ == 0) first_brightness_ = *brightness_;
    else if (*brightness_ != first_brightness_) mixed_ = 1;
    ++set_;
    if (r | g | b) ++lit_;
  }
  void Reset() { set_ = 0; lit_ = 0; mixed_ = 0; first_brightness_ = *brightness_; }
  long set_, lit_;
  int mixed_;
  uint8_t first_brightness_;
private:
  const uint8_t *brightness_;
};

class RGBMatrix {
public:
  struct Options {
    Options() : hardware_mapping("regular"), rows(32), cols(32), chain_length(1), parallel(1),
                scan_mode(0), pwm_bits(11), pwm_lsb_nanoseconds(130), pwm_dither_bits(0),
                brightness(100), multiplexing(0) {}
    const char *hardware_mapping;
    int rows, cols, chain_length, parallel, scan_mode, pwm_bits, pwm_lsb_nanoseconds,
        pwm_dither_bits, brightness, multiplexing;
  };

  explicit RGBMatrix(const Options &o)
    : w_(o.cols * o.chain_length), h_(o.rows * o.parallel), brightness_((uint8_t)o.brightness),
      a_(&brightness_), b_(&brightness_), log_(NULL) {
    const char *path = getenv("FAKE_MATRIX_LOG");
    if (path && *path) { log_ = fopen(path, "a"); if (log_) setvbuf(log_, NULL, _IOLBF, 0); }
  }
  ~RGBMatrix() { if (log_) fclose(log_); }

  int width() const { return w_; }
  int height() const { return h_; }
  FrameCanvas *CreateFrameCanvas() { return &a_; }
  FrameCanvas *SwapOnVSync(FrameCanvas *c) {
    if (log_) fprintf(log_, "frame b=%d set=%ld lit=%ld mixed=%d\n",
                      c->set_ ? c->first_brightness_ : brightness_, c->set_, c->lit_, c->mixed_);
    FrameCanvas *other = (c == &a_) ? &b_ : &a_;
    other->Reset();
    return other;
  }
  void SetBrightness(uint8_t b) { brightness_ = b; }
  uint8_t brightness() { return brightness_; }
  void Clear() {}

private:
  int w_, h_;
  uint8_t brightness_;
  FrameCanvas a_, b_;
  FILE *log_;
};

inline bool FakeIntFlag(const char *arg, const char *name, int *out) {
  const size_t n = strlen(name);
  if (strncmp(arg, name, n) != 0 || arg[n] != '=') return false;
  *out = atoi(arg + n + 1);
  return true;
}

inline RGBMatrix *CreateMatrixFromFlags(int *argc, char ***argv, RGBMatrix::Options *o,
                                        RuntimeOptions *rt) {
  int kept = 1;
  for (int i = 1; i < *argc; ++i) {
    const char *a = (*argv)[i];
    if (strncmp(a, "--led-", 6) != 0) { (*argv)[kept++] = (*argv)[i]; continue; }
    if (FakeIntFlag(a, "--led-brightness", &o->brightness)) continue;
    if (FakeIntFlag(a, "--led-pwm-bits", &o->pwm_bits)) continue;
    if (FakeIntFlag(a, "--led-slowdown-gpio", &rt->gpio_slowdown)) continue;
    fprintf(stderr, "Option %s starts with --led- but it is unknown. Typo?\n", a);
  }
  *argc = kept;
  if (o->brightness < 1 || o->brightness > 100) {
    fprintf(stderr, "Brightness is outside usable range.\n");
    return NULL;
  }
  return new RGBMatrix(*o);
}

}  // namespace rgb_matrix

#endif
