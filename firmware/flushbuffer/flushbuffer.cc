// flushBuffer2 — KSC Wiedikon open rebuild of the Tech4Sport flushBuffer.
//
// Displays a PNG on the LED matrix, reloading it each frame (~62 fps), exactly
// like the vendor binary — but built on the open-source hzeller
// rpi-rgb-led-matrix library with the custom `applicon` GPIO mapping, with NO
// licence check and NO GraphicsMagick (PNG via stb_image). It links only stock
// Debian-12 libraries, so the /home/pi/ledbox/lib legacy staging
// (libcrypto1.1 / libtiff5 / libwebp6 / GraphicsMagick) is no longer needed.
//
// The geometry and scan_mode are compiled in, exactly as the vendor did — they
// are NOT passed on the command line. Any --led-* flag still overrides them
// (CreateMatrixFromFlags runs after these defaults, mirroring the vendor main).
//
// Effective config recovered from the vendor binary (unstripped, via gdb/objdump):
//   rows=64 cols=64 chain=3 parallel=1 scan_mode=1  -> 192x64
//   gpio-mapping=applicon  slowdown=5  pwm-bits=7  pwm-lsb=450  dither=2
//   multiplexing=1  brightness=40
//
// LIVE CONTROL. Brightness used to be a launch flag and nothing else, so every change in the
// console rewrote setting.ini and killed + relaunched this process under a lock (PANEL_RESTART in
// src/panelBrightness.js): a dark gap on every change, and the source of the two-drivers vertical
// flicker races. hzeller's SetBrightness() works at runtime and only affects pixels set after it,
// and this loop re-sets every pixel every frame, so a new level is on the glass one frame later.
// The channel is a directory on tmpfs (/run/ledbox-panel; --ctl-dir=PATH moves it, --ctl-dir=
// with nothing after it switches it off):
//
//   brightness  one number, 0-100, written by the appliance. 0 = draw black but keep running: the
//               GPIO stays ours, so switching the panel back on needs no restart. No file = the
//               --led-brightness this process was started with (setting.ini's value, via startled).
//   power       key=value lines for the power governor below. No file = the --power-* flags.
//   driver      written BY this process once the matrix is up: its pid, its start time (field 22
//               of /proc/<pid>/stat) and what it reads. The appliance and the watchdog use the
//               channel only when this file names a live process with exactly that start time. An
//               older flushBuffer2 never writes it and a killed one leaves a dead pid behind, so
//               both fall back to the old rewrite-and-restart — which is what keeps a board whose
//               binary has not been rebuilt yet working exactly as before.
//   status      what is on the glass: requested and shown brightness, the governor's cap, the
//               frame's mean duty and the estimated current. Rewritten at most once a second, and
//               only when something in it changed.
//
// Both files are re-read every few frames (~100 ms). They are tiny and on tmpfs, so polling costs
// nothing and needs no signal plumbing: whoever writes them needs no rights over this process.
//
// POWER GOVERNOR (for the DIY build, where 3+ indoor panels at full white can draw far more than
// the supply or a USB-PD charger delivers; off unless a budget is set, and the C0270 runs with it
// off). Before each frame is drawn, its current is estimated from the pixels themselves:
//
//   I = idle_ma + sum over R,G,B of  <channel>_ma * (sum of that channel's duty) / (full duty * pixels)
//
// where duty is hzeller's own CIE1931 mapping of the value at the given brightness, cut to the PWM
// planes actually shown — LED current follows that duty, not the raw RGB value (grey 128 at
// brightness 100 is ~19 % duty, not 50 %). <channel>_ma is the whole panel's current for that
// channel at full value and brightness 100, i.e. the calibration. If the budget is set, the frame is
// drawn at the highest brightness at or below the requested one whose estimate fits. Going down
// happens on the frame that needs it — before that frame reaches the glass; coming back up is
// limited to rise_per_s brightness points a second, and the level starts from black when the
// driver starts, so neither a white frame after a dark one nor the boot is a step load.
//
// power keys (file lines `key=value`, or --power-<key with - for _>=value on the command line):
//   budget_ma      the current the panel may draw, in mA. 0 or absent = governor off.
//   full_white_ma  calibration: whole-panel current at full white, brightness 100, minus idle_ma.
//                  Split evenly over R/G/B. Default 24000: docs/diy-panel/BUILD.md section 2's worst
//                  case for three 64x64 P5 panels — calibrate rather than trust it (README.md).
//   red_ma green_ma blue_ma   the same per channel, overriding full_white_ma's even split.
//   idle_ma        what the same rail draws with the panel black (driver ICs). Default 0.
//   rise_per_s     how fast the governor lets brightness climb, in points per second. Default 50
//                  (0 to 40 in 0.8 s). 0 = no limit.
// The calibration holds for one PWM tuning (pwm bits, lsb nanoseconds, slowdown, limit-refresh):
// those change how much of each frame the LEDs are lit, so after retuning, calibrate again.

#include "led-matrix.h"
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#include "stb_image.h"

using rgb_matrix::RGBMatrix;
using rgb_matrix::FrameCanvas;

static volatile sig_atomic_t interrupt_received = 0;
static void InterruptHandler(int) { interrupt_received = 1; }

static const char kDefaultCtlDir[] = "/run/ledbox-panel";
static const int kPollEveryFrames = 6;      // ~100 ms at ~62 fps
static const double kStatusEverySec = 1.0;
static const int kBitPlanes = 11;           // hzeller's internal resolution (framebuffer-internal.h)

// ---------------------------------------------------------------------------------------------
// Small files on tmpfs.

// The whole of a small file, NUL-terminated. False if it is missing or unreadable.
static bool ReadSmall(const char *path, char *buf, size_t cap) {
  const int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  size_t n = 0;
  while (n + 1 < cap) {
    const ssize_t r = read(fd, buf + n, cap - 1 - n);
    if (r < 0) { if (errno == EINTR) continue; close(fd); return false; }
    if (r == 0) break;
    n += (size_t)r;
  }
  close(fd);
  buf[n] = 0;
  return true;
}

// Write a small file as a temp file + rename, so a reader never sees half of one.
static bool WriteSmall(const char *dir, const char *name, const char *text) {
  char path[512], tmp[512];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  snprintf(tmp, sizeof tmp, "%s/.%s.%d", dir, name, (int)getpid());
  const int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0) return false;
  const size_t len = strlen(text);
  bool ok = write(fd, text, len) == (ssize_t)len;
  ok = (close(fd) == 0) && ok;
  if (!ok || rename(tmp, path) != 0) { unlink(tmp); return false; }
  return true;
}

// A whole decimal number (at most 9 digits) with nothing but whitespace around it, from s up to
// end. -1 for anything else — an empty file mid-write, a stray word, a negative or a fraction —
// which the callers treat as "no change" rather than guessing what was meant.
static long ParseCount(const char *s, const char *end) {
  while (s < end && (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n')) ++s;
  while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' || end[-1] == '\n')) --end;
  if (s == end || end - s > 9) return -1;
  long v = 0;
  for (const char *p = s; p < end; ++p) {
    if (*p < '0' || *p > '9') return -1;
    v = v * 10 + (*p - '0');
  }
  return v;
}

// This process's start time in clock ticks since boot: field 22 of /proc/self/stat, counted after
// the ")" that closes the command name (which may itself hold spaces). With the pid it names this
// run of this process uniquely for the life of the boot, even once the pid is reused.
static bool OwnStartTime(char *out, size_t cap) {
  char stat[1024];
  if (!ReadSmall("/proc/self/stat", stat, sizeof stat)) return false;
  const char *p = strrchr(stat, ')');
  if (p == NULL) return false;
  p += 2;                                   // past ") " to field 3, the state
  for (int field = 3; field < 22; ++field) {
    p = strchr(p, ' ');
    if (p == NULL) return false;
    ++p;
  }
  size_t n = strspn(p, "0123456789");
  if (n == 0 || n >= cap) return false;
  memcpy(out, p, n);
  out[n] = 0;
  return true;
}

// The control directory, made while we are still root: CreateMatrixFromFlags drops this process to
// the `daemon` user once the GPIO is ours, and from then on it could neither create the directory
// nor write the `driver` file into one that root owns. World-writable on purpose, and deliberately
// without the sticky bit: the appliance (pi) writes `brightness`, this process (daemon) writes
// `driver` and `status`, the watchdog (root) may remove a stale `brightness` — and with a sticky bit,
// a file a person once wrote by hand with sudo would lock the appliance out of replacing it. Every
// account on this board that can write here can sudo anyway, so there is no boundary to protect.
static void PrepareCtlDir(const char *dir) {
  if (mkdir(dir, 0777) != 0 && errno != EEXIST) {
    fprintf(stderr, "flushBuffer2: cannot create %s (%s); live control off\n", dir, strerror(errno));
    return;
  }
  struct stat st;
  if (lstat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) {
    fprintf(stderr, "flushBuffer2: %s is not a directory; live control off\n", dir);
    return;
  }
  // mkdir's mode passes through the umask, chmod's does not.
  if ((st.st_mode & 07777) != 0777 && chmod(dir, 0777) != 0)
    fprintf(stderr, "flushBuffer2: cannot open up %s (%s)\n", dir, strerror(errno));
}

// ---------------------------------------------------------------------------------------------
// Power governor.

enum PowerKey { kBudget, kFullWhite, kRed, kGreen, kBlue, kIdle, kRise, kPowerKeys };
static const char *const kPowerKeyNames[kPowerKeys] = {
  "budget_ma", "full_white_ma", "red_ma", "green_ma", "blue_ma", "idle_ma", "rise_per_s",
};

// One layer of power settings (the --power-* flags, or the power file): only what it sets.
struct PowerLayer {
  long value[kPowerKeys];
  bool set[kPowerKeys];
};

struct PowerConfig {
  long budget_ma;
  long channel_ma[3];   // R, G, B
  long idle_ma;
  long rise_per_s;
  bool operator!=(const PowerConfig &o) const {
    return budget_ma != o.budget_ma || channel_ma[0] != o.channel_ma[0]
        || channel_ma[1] != o.channel_ma[1] || channel_ma[2] != o.channel_ma[2]
        || idle_ma != o.idle_ma || rise_per_s != o.rise_per_s;
  }
};

static const PowerConfig kPowerDefaults = { 0, { 8000, 8000, 8000 }, 0, 50 };

// `key` is either the file's spelling (budget_ma) or the flag's (budget-ma). False if unknown.
static bool SetPowerKey(PowerLayer *layer, const char *key, size_t key_len, long value) {
  for (int k = 0; k < kPowerKeys; ++k) {
    const char *name = kPowerKeyNames[k];
    if (strlen(name) != key_len) continue;
    bool same = true;
    for (size_t i = 0; i < key_len && same; ++i)
      same = (key[i] == name[i]) || (key[i] == '-' && name[i] == '_');
    if (!same) continue;
    layer->value[k] = value;
    layer->set[k] = true;
    return true;
  }
  return false;
}

// Lay `layer` over `base`. full_white_ma first, so a per-channel key in the same layer wins.
static PowerConfig ApplyLayer(PowerConfig c, const PowerLayer &layer) {
  if (layer.set[kBudget]) c.budget_ma = layer.value[kBudget];
  if (layer.set[kFullWhite]) {
    c.channel_ma[0] = c.channel_ma[1] = c.channel_ma[2] = layer.value[kFullWhite] / 3;
  }
  if (layer.set[kRed])   c.channel_ma[0] = layer.value[kRed];
  if (layer.set[kGreen]) c.channel_ma[1] = layer.value[kGreen];
  if (layer.set[kBlue])  c.channel_ma[2] = layer.value[kBlue];
  if (layer.set[kIdle])  c.idle_ma = layer.value[kIdle];
  if (layer.set[kRise])  c.rise_per_s = layer.value[kRise];
  return c;
}

// The power file: `key=value` lines, # comments and blank lines allowed. A line that does not
// parse is skipped with a warning; the rest of the file still applies.
static void ParsePowerFile(const char *text, PowerLayer *layer) {
  memset(layer, 0, sizeof *layer);
  const char *line = text;
  while (*line) {
    const char *eol = strchr(line, '\n');
    if (eol == NULL) eol = line + strlen(line);
    const char *s = line;
    while (s < eol && (*s == ' ' || *s == '\t')) ++s;
    if (s < eol && *s != '#' && *s != '\r') {
      const char *eq = (const char *)memchr(s, '=', eol - s);
      const char *key_end = eq;
      while (key_end != NULL && key_end > s && (key_end[-1] == ' ' || key_end[-1] == '\t')) --key_end;
      const long v = eq ? ParseCount(eq + 1, eol) : -1;
      if (eq == NULL || v < 0 || !SetPowerKey(layer, s, key_end - s, v))
        fprintf(stderr, "flushBuffer2: power: ignoring line \"%.*s\"\n", (int)(eol - s), s);
    }
    line = (*eol) ? eol + 1 : eol;
  }
}

// hzeller's CIE1931 mapping, verbatim from luminance_cie1931() in lib/framebuffer.cc at the pinned
// SHA (build.sh), so the estimate uses the exact value each pixel will be driven with.
static uint16_t Cie1931(uint8_t c, uint8_t brightness) {
  float out_factor = ((1 << kBitPlanes) - 1);
  float v = (float) c * brightness / 255.0;
  return roundf(out_factor * ((v <= 8) ? v / 902.3 : pow((v + 16) / 116.0, 3)));
}

// duty[b][c]: what value c at brightness b puts on the planes this panel actually shows. With
// pwm_bits=7 the lowest 11-7=4 planes are never sent, so their share of the value is no current.
static uint16_t duty[101][256];
static double full_duty = 1;   // duty[100][255]: full white at full brightness

static void BuildDutyTable(int pwm_bits) {
  if (pwm_bits < 1) pwm_bits = 1;
  if (pwm_bits > kBitPlanes) pwm_bits = kBitPlanes;
  const uint16_t shown = (uint16_t)(((1 << kBitPlanes) - 1) & ~((1 << (kBitPlanes - pwm_bits)) - 1));
  for (int c = 0; c < 256; ++c) duty[0][c] = 0;
  for (int b = 1; b <= 100; ++b)
    for (int c = 0; c < 256; ++c) duty[b][c] = Cie1931((uint8_t)c, (uint8_t)b) & shown;
  full_duty = duty[100][255] ? duty[100][255] : 1;
}

// The frame as three histograms of 8-bit values: everything the estimate needs, and 256 entries
// per channel to weigh at each candidate brightness instead of 192x64 pixels.
struct Histogram { uint32_t n[3][256]; double pixels; };

// Sum of one channel's duty at brightness b, as a fraction of every pixel at full white.
static double ChannelDuty(const Histogram &h, int ch, int b) {
  double sum = 0;
  for (int v = 1; v < 256; ++v) sum += (double)h.n[ch][v] * duty[b][v];
  return sum / (full_duty * h.pixels);
}

static double EstimateMa(const Histogram &h, const PowerConfig &p, int b) {
  double ma = p.idle_ma;
  for (int ch = 0; ch < 3; ++ch) ma += p.channel_ma[ch] * ChannelDuty(h, ch, b);
  return ma;
}

// Highest brightness in [1, want] whose estimate fits the budget. The estimate never falls as
// brightness rises, so a binary search finds it in about seven tries. If even brightness 1 is over
// (the budget is below idle_ma) there is nothing left to dim: 1 it is, and the status says so.
static int GovernorCap(const Histogram &h, const PowerConfig &p, int want) {
  if (want < 1) return want;
  if (EstimateMa(h, p, want) <= p.budget_ma) return want;
  if (EstimateMa(h, p, 1) > p.budget_ma) return 1;
  int lo = 1, hi = want;   // lo fits, hi does not
  while (hi - lo > 1) {
    const int mid = (lo + hi) / 2;
    if (EstimateMa(h, p, mid) <= p.budget_ma) lo = mid; else hi = mid;
  }
  return lo;
}

static double Now() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static void LogPower(const PowerConfig &p) {
  if (p.budget_ma <= 0) { fprintf(stderr, "flushBuffer2: power governor off\n"); return; }
  fprintf(stderr, "flushBuffer2: power governor on: budget %ld mA, full R/G/B %ld/%ld/%ld mA, "
          "idle %ld mA, rise %ld/s\n", p.budget_ma, p.channel_ma[0], p.channel_ma[1],
          p.channel_ma[2], p.idle_ma, p.rise_per_s);
}

// ---------------------------------------------------------------------------------------------

int main(int argc, char *argv[]) {
  const char *image_path =
      (argc > 1 && argv[1][0] != '-') ? argv[1] : "/home/pi/ledbox/www/buffer.png";

  // Our own flags. They do not start with --led-, so CreateMatrixFromFlags leaves them alone (and
  // the old binary simply ignored them). Read first: the control directory has to be made while
  // this process is still root.
  const char *ctl_dir = kDefaultCtlDir;
  PowerLayer power_flags;
  memset(&power_flags, 0, sizeof power_flags);
  for (int i = 1; i < argc; ++i) {
    const char *a = argv[i];
    if (strncmp(a, "--ctl-dir=", 10) == 0) { ctl_dir = a + 10; continue; }
    if (strncmp(a, "--power-", 8) != 0) continue;
    const char *key = a + 8;
    const char *eq = strchr(key, '=');
    const long v = eq ? ParseCount(eq + 1, eq + 1 + strlen(eq + 1)) : -1;
    if (eq == NULL || v < 0 || !SetPowerKey(&power_flags, key, eq - key, v))
      fprintf(stderr, "flushBuffer2: ignoring %s\n", a);
  }
  const bool live = ctl_dir[0] != 0;
  if (live) PrepareCtlDir(ctl_dir);

  RGBMatrix::Options opt;
  rgb_matrix::RuntimeOptions rt;
  opt.hardware_mapping    = "applicon";
  opt.rows                = 64;
  opt.cols                = 64;
  opt.chain_length        = 3;
  opt.parallel            = 1;
  opt.scan_mode           = 1;
  opt.pwm_bits            = 7;
  opt.pwm_lsb_nanoseconds = 450;
  opt.pwm_dither_bits     = 2;
  opt.brightness          = 40;
  opt.multiplexing        = 1;
  rt.gpio_slowdown        = 5;

  RGBMatrix *matrix = rgb_matrix::CreateMatrixFromFlags(&argc, &argv, &opt, &rt);
  if (matrix == NULL) { fprintf(stderr, "flushBuffer2: could not init matrix\n"); return 1; }

  signal(SIGTERM, InterruptHandler);
  signal(SIGINT, InterruptHandler);

  FrameCanvas *canvas = matrix->CreateFrameCanvas();
  const int W = matrix->width();
  const int H = matrix->height();
  BuildDutyTable(opt.pwm_bits);

  char brightness_path[512], power_path[512];
  snprintf(brightness_path, sizeof brightness_path, "%s/brightness", ctl_dir);
  snprintf(power_path, sizeof power_path, "%s/power", ctl_dir);

  // The launch value (setting.ini via startled) is what "no brightness file" means.
  const int start_brightness = opt.brightness;
  int requested = start_brightness;
  const PowerConfig flag_power = ApplyLayer(kPowerDefaults, power_flags);
  PowerConfig power = flag_power;
  // Raw contents last seen, so a file is parsed (and complained about) only when it changes.
  char seen_brightness[64] = "\x01", seen_power[2048] = "\x01";

  // Announce the channel. Written after the matrix is up (and privileges are dropped), so a
  // driver that failed to start never claims it.
  char start_time[32] = "";
  if (live) {
    char text[256];
    if (OwnStartTime(start_time, sizeof start_time)) {
      snprintf(text, sizeof text,
               "# flushBuffer2 live control: brightness and power in this directory are read live\n"
               "pid=%d\nstart=%s\ncontrol=brightness power\n", (int)getpid(), start_time);
      if (!WriteSmall(ctl_dir, "driver", text))
        fprintf(stderr, "flushBuffer2: cannot write %s/driver (%s); the appliance will restart "
                "the driver for every brightness change\n", ctl_dir, strerror(errno));
    }
    fprintf(stderr, "flushBuffer2: live control in %s (start brightness %d)\n", ctl_dir, start_brightness);
  }
  LogPower(power);

  // Re-read both control files; act only on a file whose contents changed since the last look.
  auto poll = [&]() {
    char buf[sizeof seen_brightness];
    const bool have = ReadSmall(brightness_path, buf, sizeof buf);
    if (!have) buf[0] = 0;
    if (strcmp(buf, seen_brightness) != 0) {
      snprintf(seen_brightness, sizeof seen_brightness, "%s", buf);
      const long v = have ? ParseCount(buf, buf + strlen(buf)) : start_brightness;
      if (v < 0 || v > 100) {
        fprintf(stderr, "flushBuffer2: ignoring %s: not a number 0-100\n", brightness_path);
      } else if (v != requested) {
        fprintf(stderr, "flushBuffer2: brightness %d -> %ld%s\n", requested, v,
                have ? "" : " (no brightness file: back to the start value)");
        requested = (int)v;
      }
    }

    char pbuf[sizeof seen_power];
    const bool have_power = ReadSmall(power_path, pbuf, sizeof pbuf);
    if (!have_power) pbuf[0] = 0;
    if (strcmp(pbuf, seen_power) != 0) {
      snprintf(seen_power, sizeof seen_power, "%s", pbuf);
      PowerLayer file_layer;
      ParsePowerFile(pbuf, &file_layer);
      const PowerConfig next = ApplyLayer(flag_power, file_layer);
      if (next != power) { power = next; LogPower(power); }
    }
  };
  // Once before the first frame, so a brightness of 0 or a budget left in the files by the driver
  // this one replaces (the watchdog restarting it, say) holds from the very first frame.
  if (live) poll();

  // The level on the glass, as a float so the governor's rise can be slower than one point per
  // frame. A governor that is on from the start begins at black: the boot fade-in.
  double shown = (power.budget_ma > 0) ? 0 : requested;
  double last_frame = Now();
  double last_status = 0;
  char last_status_text[256] = "";
  unsigned long limited_frames = 0;
  Histogram hist;

  for (unsigned frame = 1; !interrupt_received; ++frame) {
    if (live && frame % kPollEveryFrames == 0) poll();

    int w = 0, h = 0, comp = 0;
    unsigned char *px = stbi_load(image_path, &w, &h, &comp, 3);
    if (px != NULL) {
      const int cw  = (w < W) ? w : W;
      const int chh = (h < H) ? h : H;

      // Histogram the part of the image that lands on the panel; the rest of the panel is black.
      memset(&hist, 0, sizeof hist);
      hist.pixels = (double)W * H;
      for (int y = 0; y < chh; ++y) {
        const unsigned char *rowp = px + (size_t)y * w * 3;
        for (int x = 0; x < cw; ++x) {
          const unsigned char *p = rowp + x * 3;
          ++hist.n[0][p[0]]; ++hist.n[1][p[1]]; ++hist.n[2][p[2]];
        }
      }

      // The level for THIS frame. Down at once (before the frame is drawn, which is the point of
      // estimating rather than measuring), up no faster than rise_per_s. dt is capped so a stall
      // (a slow card, a busy CPU) does not turn into one big step.
      const double now = Now();
      double dt = now - last_frame;
      last_frame = now;
      if (dt > 0.1) dt = 0.1;
      const bool governed = power.budget_ma > 0;
      const int cap = governed ? GovernorCap(hist, power, requested) : requested;
      if (cap < requested) ++limited_frames;
      if (!governed || power.rise_per_s <= 0 || cap <= shown) {
        shown = cap;
      } else {
        shown += power.rise_per_s * dt;
        if (shown > cap) shown = cap;
      }
      const int level = (int)shown;

      if (level >= 1) {
        if (matrix->brightness() != level) matrix->SetBrightness((uint8_t)level);
        canvas->Fill(0, 0, 0);
        for (int y = 0; y < chh; ++y) {
          const unsigned char *rowp = px + (size_t)y * w * 3;
          for (int x = 0; x < cw; ++x) {
            const unsigned char *p = rowp + x * 3;
            canvas->SetPixel(x, y, p[0], p[1], p[2]);
          }
        }
      } else {
        canvas->Fill(0, 0, 0);   // brightness 0: dark, and still ours
      }
      stbi_image_free(px);
      canvas = matrix->SwapOnVSync(canvas);

      if (live && now - last_status >= kStatusEverySec) {
        const double mean = level >= 1 ? (ChannelDuty(hist, 0, level) + ChannelDuty(hist, 1, level)
                                          + ChannelDuty(hist, 2, level)) / 3 : 0;
        char text[256], cap_text[16];
        if (governed) snprintf(cap_text, sizeof cap_text, "%d", cap);
        else snprintf(cap_text, sizeof cap_text, "off");
        snprintf(text, sizeof text,
                 "requested=%d shown=%d cap=%s budget_ma=%ld duty=%.4f est_ma=%.0f limited_frames=%lu\n",
                 requested, level, cap_text, power.budget_ma, mean,
                 level >= 1 ? EstimateMa(hist, power, level) : (double)power.idle_ma, limited_frames);
        if (strcmp(text, last_status_text) != 0 && WriteSmall(ctl_dir, "status", text))
          snprintf(last_status_text, sizeof last_status_text, "%s", text);
        last_status = now;
      }
    }
    usleep(16000);  // ~62 fps, matching the vendor
  }

  // A clean exit withdraws the channel, so nobody writes a brightness for a driver that is gone.
  // Only if the file is still ours: never pull it out from under a driver that started since.
  if (live) {
    char path[512], text[256], mine[64];
    snprintf(path, sizeof path, "%s/driver", ctl_dir);
    snprintf(mine, sizeof mine, "\npid=%d\n", (int)getpid());
    if (ReadSmall(path, text, sizeof text) && strstr(text, mine) != NULL) {
      unlink(path);
      snprintf(path, sizeof path, "%s/status", ctl_dir);
      unlink(path);
    }
  }

  matrix->Clear();
  delete matrix;
  return 0;
}
