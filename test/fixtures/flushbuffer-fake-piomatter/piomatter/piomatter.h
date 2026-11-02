// Stand-in for Adafruit Piomatter's include/piomatter/piomatter.h, for test/flushbuffer-selftest.mjs:
// just the part of the API firmware/flushbuffer/flushbuffer.cc's piomatter backend uses
// (-DFLUSHBUFFER_PIOMATTER), with no PIO, no /dev/pio0 and no refresh thread. C++20, like the real one.
//
// Every show() appends one line to $FAKE_MATRIX_LOG:
//   frame bf=<the brightness float show() saw> lit=<non-black framebuffer pixels> px=<all of them>
// The constructor refuses a pixel map that is not a permutation of the framebuffer (every glass
// pixel exactly once), the way a wrong map would draw garbage on the real thing.
//
// The schedule is Piomatter's simple one (make_simple_schedule + rescale_schedule, matrixmap.h at
// the pinned SHA): a binary plane per bit, the longest stretched to at least pixels_across. The
// temporal-dither variant is not reproduced; the driver only sums whatever schedules it is given.

#ifndef FAKE_PIOMATTER_H
#define FAKE_PIOMATTER_H

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <algorithm>
#include <span>
#include <stdexcept>
#include <vector>

namespace piomatter {

using matrix_map = std::vector<int>;
struct schedule_entry { uint32_t shift, active_time; };
using schedule = std::vector<schedule_entry>;
using schedule_sequence = std::vector<schedule>;

struct active3_pinout {};
struct active3_pinout_bgr {};

struct gamma_lut {   // verbatim from render.h
  gamma_lut(double exponent = 2.2) {
    for (int i = 0; i < 256; i++) lut[i] = std::max(i, int(round(1023 * pow(i / 255., exponent))));
  }
  unsigned convert(unsigned v) { return v >= 256 ? 1023 : lut[v]; }
  uint16_t lut[256];
};

struct colorspace_rgb888 { using data_type = uint32_t; };

struct matrix_geometry {
  matrix_geometry(size_t pixels_across, size_t n_addr_lines, int n_planes, int n_temporal_planes,
                  size_t width, size_t height, matrix_map map, size_t n_lanes)
    : pixels_across(pixels_across), n_addr_lines(n_addr_lines), n_lanes(n_lanes), width(width),
      height(height), map(map) {
    if (map.size() != (n_lanes << n_addr_lines) * pixels_across)
      throw std::range_error("map size does not match calculated pixel count");
    std::vector<char> seen(width * height, 0);
    for (int i : map) {
      if (i < 0 || (size_t)i >= seen.size() || seen[i]) throw std::range_error("map is not a permutation");
      seen[i] = 1;
    }
    if (n_planes < 1 || n_planes > 10) throw std::range_error("n_planes out of range");
    if (n_temporal_planes >= 2 && n_temporal_planes >= n_planes)
      throw std::range_error("n_temporal_planes can't exceed n_planes");
    schedule s;
    for (int i = 0; i < n_planes; i++) s.push_back({(uint32_t)(9 - i), 1u << (n_planes - i - 1)});
    const uint32_t longest = s.front().active_time;
    if (longest < pixels_across) {
      const uint32_t scale = (pixels_across + longest - 1) / longest;
      for (auto &e : s) e.active_time *= scale;
    }
    schedules.push_back(s);
  }
  size_t pixels_across, n_addr_lines, n_lanes, width, height;
  matrix_map map;
  schedule_sequence schedules;
};

struct piomatter_base {
  virtual ~piomatter_base() {}
  virtual int show() = 0;
  double fps = 0;
  float brightness = 1.0f;
};

template <class pinout, class colorspace>
struct piomatter : piomatter_base {
  piomatter(std::span<typename colorspace::data_type const> fb, const matrix_geometry &)
    : fb_(fb), log_(NULL) {
    const char *path = getenv("FAKE_MATRIX_LOG");
    if (path && *path) { log_ = fopen(path, "a"); if (log_) setvbuf(log_, NULL, _IOLBF, 0); }
    // The real constructor shows the framebuffer once; it is still all black. Not logged, so the
    // log holds exactly the driver's own frames.
  }
  ~piomatter() { if (log_) fclose(log_); }
  int show() override {
    long lit = 0;
    for (uint32_t v : fb_) if (v & 0xffffff) ++lit;
    if (log_) fprintf(log_, "frame bf=%.6f lit=%ld px=%zu\n", brightness, lit, fb_.size());
    fps = 250;
    return 0;
  }
  std::span<typename colorspace::data_type const> fb_;
  FILE *log_;
};

}  // namespace piomatter

#endif
