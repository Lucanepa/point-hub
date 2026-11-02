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
//
// TWO BACKENDS, chosen when it is built (build.sh): everything above — the PNG, the control files,
// the governor, the signals, the log — is shared, and only the class Panel below differs.
//   hzeller    (default) rpi-rgb-led-matrix: the C0270 and any Pi 1-4 build. Unchanged from the
//              driver before the split. (The pinned commit also has experimental Pi 5 backends,
//              --led-rp1-pio; untried here, see README.md.)
//   piomatter  (BACKEND=piomatter, -DFLUSHBUFFER_PIOMATTER) Adafruit's Piomatter, which drives
//              HUB75 from the Raspberry Pi 5's RP1 PIO through piolib (/dev/pio0). Its
//              compiled-in geometry is the Point Hub board's (design D: Triple Bonnet, 64x32
//              1/16-scan modules, 3 outputs x 3 slots = 192x96), and it understands the --led-*
//              flags startled passes, mapped onto what Piomatter has (Panel::Create there says
//              which mean nothing on a Pi 5 and are only noted). Needs C++20 (Piomatter's own).

#if !defined(FLUSHBUFFER_PIOMATTER)
#include "led-matrix.h"
#endif
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
#if defined(FLUSHBUFFER_PIOMATTER)
// After the C headers: Piomatter's own headers use pow, round and strerror without including them.
#include <grp.h>
#include <pthread.h>
#include <pwd.h>
#include <strings.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <exception>
#include <vector>
#include "piomatter/piomatter.h"
#endif

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#include "stb_image.h"

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

// duty[b][c]: how long value c at brightness b keeps an LED lit, in the backend's own units; only
// its ratio to full_duty matters. Each backend fills it (Panel::BuildDutyTable).
static float duty[101][256];
static double full_duty = 1;   // duty[100][255]: full white at full brightness

#if !defined(FLUSHBUFFER_PIOMATTER)
// hzeller's CIE1931 mapping, verbatim from luminance_cie1931() in lib/framebuffer.cc at the pinned
// SHA (build.sh), so the estimate uses the exact value each pixel will be driven with.
static uint16_t Cie1931(uint8_t c, uint8_t brightness) {
  float out_factor = ((1 << kBitPlanes) - 1);
  float v = (float) c * brightness / 255.0;
  return roundf(out_factor * ((v <= 8) ? v / 902.3 : pow((v + 16) / 116.0, 3)));
}

// hzeller: the value's CIE1931 duty, cut to the planes this panel actually shows. With
// pwm_bits=7 the lowest 11-7=4 planes are never sent, so their share of the value is no current.
static void BuildHzellerDutyTable(int pwm_bits) {
  if (pwm_bits < 1) pwm_bits = 1;
  if (pwm_bits > kBitPlanes) pwm_bits = kBitPlanes;
  const uint16_t shown = (uint16_t)(((1 << kBitPlanes) - 1) & ~((1 << (kBitPlanes - pwm_bits)) - 1));
  for (int c = 0; c < 256; ++c) duty[0][c] = 0;
  for (int b = 1; b <= 100; ++b)
    for (int c = 0; c < 256; ++c) duty[b][c] = Cie1931((uint8_t)c, (uint8_t)b) & shown;
  full_duty = duty[100][255] ? duty[100][255] : 1;
}
#endif

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
// The panel. One class per backend with the same members, picked at compile time (no virtual
// calls in the per-pixel loop, and the hzeller build is the code it was):
//   static Panel *Create(int *argc, char ***argv)  geometry + --led-* flags; NULL if it cannot start.
//                                                  Consumes the --led-* flags, leaves the rest.
//   width() height()       the canvas
//   start_brightness()     the --led-brightness it was started with, 1..100
//   pwm_bits()             for the log
//   name()                 the backend, for the driver file and the log
//   BuildDutyTable()       fills duty[][] for the governor with this backend's own drive curve
//   BeginFrame(level)      a new frame, all black, whose pixels light at `level` (0 = dark)
//   SetPixel(x, y, r, g, b)
//   Show()                 the frame goes to the glass
//   ~Panel()               black, hardware released

#if !defined(FLUSHBUFFER_PIOMATTER)

class Panel {
 public:
  static Panel *Create(int *argc, char ***argv) {
    rgb_matrix::RGBMatrix::Options opt;
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

    rgb_matrix::RGBMatrix *matrix = rgb_matrix::CreateMatrixFromFlags(argc, argv, &opt, &rt);
    if (matrix == NULL) return NULL;
    return new Panel(matrix, opt.brightness, opt.pwm_bits);
  }
  ~Panel() {
    matrix_->Clear();
    delete matrix_;
  }

  int width() const { return matrix_->width(); }
  int height() const { return matrix_->height(); }
  int start_brightness() const { return start_brightness_; }
  int pwm_bits() const { return pwm_bits_; }
  const char *name() const { return "hzeller"; }
  void BuildDutyTable() const { BuildHzellerDutyTable(pwm_bits_); }

  // hzeller's SetBrightness only affects pixels set after it, so it goes first. At 0 the level is
  // left alone (hzeller has no 0) and the frame simply stays black.
  void BeginFrame(int level) {
    if (level >= 1 && matrix_->brightness() != level) matrix_->SetBrightness((uint8_t)level);
    canvas_->Fill(0, 0, 0);
  }
  void SetPixel(int x, int y, uint8_t r, uint8_t g, uint8_t b) { canvas_->SetPixel(x, y, r, g, b); }
  void Show() { canvas_ = matrix_->SwapOnVSync(canvas_); }

 private:
  Panel(rgb_matrix::RGBMatrix *m, int start_brightness, int pwm_bits)
    : matrix_(m), canvas_(m->CreateFrameCanvas()), start_brightness_(start_brightness),
      pwm_bits_(pwm_bits) {}
  Panel(const Panel &);
  Panel &operator=(const Panel &);

  rgb_matrix::RGBMatrix *matrix_;
  rgb_matrix::FrameCanvas *canvas_;
  const int start_brightness_, pwm_bits_;
};

#else  // FLUSHBUFFER_PIOMATTER

// Piomatter on the Pi 5. What it offers, and how the driver's notions land on it:
//   geometry     width x height framebuffer, n_addr_lines (1/16 scan = 4: rows A-D, the E line
//                GPIO15 left untouched), n_lanes = 2 per HUB75 output, and a map from each shifted
//                pixel to a framebuffer index. The map below is Piomatter's simple_multilane_mapper
//                (pixelmappers.py): output 1 is rows 0..rows-1, output 2 the next, output 3 the
//                next, and within an output x runs along the chain — the same canvas hzeller builds
//                with --led-parallel=3 --led-chain=3, so the 192x96 layout of docs/diy-panel/BUILD.md
//                section 4.1 holds unchanged: the 192x64 front on outputs 1+2, the bench modules on
//                output 3 (rows 64-95).
//   pinout       active3_pinout = hzeller's "regular" pins (the Triple Bonnet's), or its _bgr twin
//                for --led-rgb-sequence=BGR. GPIO0/1 are not in it (I2C0 stays free).
//   n_planes     colour depth, 1-10 bit planes (hzeller has 11): from --led-pwm-bits, capped at 10.
//   n_temporal_planes   the lowest planes shown in turns across refreshes: from
//                --led-pwm-dither-bits (hzeller's own time dithering of the low bits is the same
//                idea, not the same algorithm). 0 or 1 = none.
//   brightness   a float 0..1 that scales how long OE is held per plane (render.h) — linear in
//                light, where hzeller's 1..100 goes through CIE1931 first. So level b is sent as
//                PmScale(b) = hzeller's CIE1931 of b: full white at a console level gives the same
//                share of full drive on both backends (40 -> 11 %), and 1..2 are dark on both.
//                Applied in show(), so a frame is never drawn at two levels.
//   show()       converts the framebuffer (gamma 2.2 to 10 bits) and queues it; a thread refreshes
//                the glass from it until the next one. Triple-buffered, so no tearing.
// Nothing in Piomatter matches --led-slowdown-gpio, --led-pwm-lsb-nanoseconds (its pixel clock is
// fixed at 13.5 MHz and the plane timing derives from it), --led-limit-refresh,
// --led-no-hardware-pulse or --led-panel-type: they are accepted, noted once and ignored, so the
// same startled works. A setting it cannot honour at all (another multiplexing, scan mode or row
// addressing, the C0270's applicon mapping) refuses to start rather than draw garbage.

static float PmScale(int b) {
  if (b <= 0) return 0;
  if (b >= 100) return 1;
  const float v = (float)b;
  return (v <= 8) ? v / 902.3f : powf((v + 16) / 116.0f, 3);
}

// --name=<digits>: true and *out set; --name=<anything else>: true, *bad set.
static bool PmIntFlag(const char *arg, const char *name, int *out, bool *bad) {
  const size_t n = strlen(name);
  if (strncmp(arg, name, n) != 0 || arg[n] != '=') return false;
  const long v = ParseCount(arg + n + 1, arg + strlen(arg));
  if (v < 0) { fprintf(stderr, "flushBuffer2: %s: not a whole number\n", arg); *bad = true; }
  else *out = (int)v;
  return true;
}

static bool PmStrFlag(const char *arg, const char *name, const char **out) {
  const size_t n = strlen(name);
  if (strncmp(arg, name, n) != 0 || arg[n] != '=') return false;
  *out = arg + n + 1;
  return true;
}

class Panel {
 public:
  static Panel *Create(int *argc, char ***argv) {
    // The Point Hub board (docs/diy-panel/BUILD.md section 4.1, 10.3). Tuning comes from startled.
    int rows = 32, cols = 64, chain = 3, parallel = 3;
    int brightness = 40, pwm_bits = 10, dither = 2;
    int scan_mode = 0, multiplexing = 0, row_addr_type = 0;
    int unused = 0;
    const char *mapping = "regular", *sequence = "RGB";
    bool show_refresh = false, drop_privs = true, bad = false;

    int kept = 1;
    for (int i = 1; i < *argc; ++i) {
      const char *a = (*argv)[i];
      if (strncmp(a, "--led-", 6) != 0) { (*argv)[kept++] = (*argv)[i]; continue; }
      if (PmIntFlag(a, "--led-rows", &rows, &bad) || PmIntFlag(a, "--led-cols", &cols, &bad)
          || PmIntFlag(a, "--led-chain", &chain, &bad) || PmIntFlag(a, "--led-parallel", &parallel, &bad)
          || PmIntFlag(a, "--led-brightness", &brightness, &bad)
          || PmIntFlag(a, "--led-pwm-bits", &pwm_bits, &bad)
          || PmIntFlag(a, "--led-pwm-dither-bits", &dither, &bad)
          || PmIntFlag(a, "--led-scan-mode", &scan_mode, &bad)
          || PmIntFlag(a, "--led-multiplexing", &multiplexing, &bad)
          || PmIntFlag(a, "--led-row-addr-type", &row_addr_type, &bad)
          || PmStrFlag(a, "--led-gpio-mapping", &mapping)
          || PmStrFlag(a, "--led-rgb-sequence", &sequence))
        continue;
      if (strcmp(a, "--led-show-refresh") == 0) { show_refresh = true; continue; }
      if (strcmp(a, "--led-no-show-refresh") == 0) { show_refresh = false; continue; }
      if (strcmp(a, "--led-no-drop-privs") == 0) { drop_privs = false; continue; }
      if (strcmp(a, "--led-drop-privs") == 0) { drop_privs = true; continue; }
      const char *noted = NULL;
      if (PmStrFlag(a, "--led-pixel-mapper", &noted)) {
        // hzeller remaps the canvas with these; drawing without one would put the picture in the
        // wrong place, so refuse rather than guess.
        if (noted[0] != 0) {
          fprintf(stderr, "flushBuffer2: %s: the Piomatter build has no pixel mappers\n", a);
          bad = true;
        }
        continue;
      }
      if (PmIntFlag(a, "--led-slowdown-gpio", &unused, &bad)
          || PmIntFlag(a, "--led-pwm-lsb-nanoseconds", &unused, &bad)
          || PmIntFlag(a, "--led-limit-refresh", &unused, &bad)
          || PmStrFlag(a, "--led-panel-type", &noted)
          || strcmp(a, "--led-no-hardware-pulse") == 0 || strcmp(a, "--led-hardware-pulse") == 0) {
        if (noted == NULL || noted[0] != 0)
          fprintf(stderr, "flushBuffer2: %s has no Piomatter equivalent on the Pi 5; ignored\n", a);
        continue;
      }
      fprintf(stderr, "Option %s starts with --led- but it is unknown. Typo?\n", a);
    }
    *argc = kept;
    (*argv)[kept] = NULL;
    if (bad) return NULL;

    // Refuse what Piomatter cannot do, the way hzeller's Options::Validate refuses a bad value.
    if (brightness < 1 || brightness > 100) {
      fprintf(stderr, "Brightness is outside usable range.\n");
      return NULL;
    }
    int n_addr_lines = 0;
    while (n_addr_lines <= 5 && (2 << n_addr_lines) != rows) ++n_addr_lines;
    if (n_addr_lines < 1 || n_addr_lines > 5) {
      fprintf(stderr, "flushBuffer2: --led-rows=%d: Piomatter needs 4, 8, 16, 32 or 64\n", rows);
      return NULL;
    }
    if (cols < 1 || chain < 1 || parallel < 1 || parallel > 3 || cols * chain > 4096) {
      fprintf(stderr, "flushBuffer2: --led-cols x --led-chain must be 1..4096 and --led-parallel "
              "1..3 (got %d x %d, %d)\n", cols, chain, parallel);
      return NULL;
    }
    if (scan_mode != 0 || multiplexing != 0 || row_addr_type != 0) {
      fprintf(stderr, "flushBuffer2: Piomatter drives progressive, direct-addressed panels only "
              "(scan-mode 0, multiplexing 0, row-addr-type 0; got %d, %d, %d)\n",
              scan_mode, multiplexing, row_addr_type);
      return NULL;
    }
    if (strcmp(mapping, "regular") != 0 && strcmp(mapping, "active3") != 0) {
      fprintf(stderr, "flushBuffer2: --led-gpio-mapping=%s: the Piomatter build knows only "
              "\"regular\" (= Piomatter's Active3, the Triple Bonnet's pins)\n", mapping);
      return NULL;
    }
    const bool bgr = strcasecmp(sequence, "BGR") == 0;
    if (!bgr && strcasecmp(sequence, "RGB") != 0) {
      fprintf(stderr, "flushBuffer2: --led-rgb-sequence=%s: Piomatter has RGB and BGR\n", sequence);
      return NULL;
    }
    if (pwm_bits < 1 || pwm_bits > 11) {
      fprintf(stderr, "flushBuffer2: --led-pwm-bits=%d: 1..11\n", pwm_bits);
      return NULL;
    }
    const int n_planes = std::min(pwm_bits, 10);
    const int n_temporal = (dither < 2) ? 0 : dither;
    if (n_temporal >= n_planes) {
      fprintf(stderr, "flushBuffer2: --led-pwm-dither-bits=%d must be below the %d planes\n",
              dither, n_planes);
      return NULL;
    }

    const int width = cols * chain, height = rows * parallel;
    const size_t n_lanes = 2 * (size_t)parallel;

    // Piomatter starts its refresh thread in the constructor. With SIGINT/SIGTERM blocked while it
    // is made, that thread never takes one (a signal there would cut a DMA transfer short); they
    // all land in this one, which main() hands to InterruptHandler.
    sigset_t stop, before;
    sigemptyset(&stop);
    sigaddset(&stop, SIGINT);
    sigaddset(&stop, SIGTERM);
    pthread_sigmask(SIG_BLOCK, &stop, &before);
    Panel *p = Create(width, height, brightness, n_planes, n_temporal, n_addr_lines, n_lanes,
                      parallel, show_refresh, bgr);
    pthread_sigmask(SIG_SETMASK, &before, NULL);
    if (p == NULL) return NULL;

    // Like hzeller: the hardware is ours (the /dev/pio0 fd stays open), so stop being root.
    if (drop_privs && geteuid() == 0) {
      struct group *g = getgrnam("daemon");
      struct passwd *u = getpwnam("daemon");
      if (g == NULL || u == NULL || setresgid(g->gr_gid, g->gr_gid, g->gr_gid) != 0
          || setresuid(u->pw_uid, u->pw_uid, u->pw_uid) != 0) {
        fprintf(stderr, "flushBuffer2: could not drop privileges to daemon (%s)\n", strerror(errno));
        delete p;
        return NULL;
      }
    }
    return p;
  }

  static Panel *Create(int width, int height, int brightness, int n_planes, int n_temporal,
                       int n_addr_lines, size_t n_lanes, int parallel, bool show_refresh, bool bgr) {
    const size_t n_addr = (size_t)1 << n_addr_lines;
    piomatter::matrix_map map;   // simple_multilane_mapper, see above
    map.reserve((size_t)width * height);
    for (size_t addr = 0; addr < n_addr; ++addr)
      for (int x = 0; x < width; ++x)
        for (size_t lane = 0; lane < n_lanes; ++lane)
          map.push_back(x + width * (int)(addr + lane * n_addr));

    Panel *p = new Panel(width, height, brightness, n_planes, show_refresh);
    try {
      piomatter::matrix_geometry geometry((size_t)width, (size_t)n_addr_lines, n_planes, n_temporal,
                                          (size_t)width, (size_t)height, map, n_lanes);
      std::span<const uint32_t> fb(p->fb_.data(), p->fb_.size());
      if (bgr) p->matter_ = new piomatter::piomatter<piomatter::active3_pinout_bgr,
                                                     piomatter::colorspace_rgb888>(fb, geometry);
      else     p->matter_ = new piomatter::piomatter<piomatter::active3_pinout,
                                                     piomatter::colorspace_rgb888>(fb, geometry);
      p->schedules_ = geometry.schedules;
    } catch (const std::exception &e) {
      // piolib itself exits(1) if /dev/pio0 cannot be opened; anything else Piomatter throws.
      fprintf(stderr, "flushBuffer2: Piomatter: %s\n", e.what());
      delete p;
      return NULL;
    }
    fprintf(stderr, "flushBuffer2: Piomatter %dx%d (%d outputs, 1/%zu scan), %d planes, %d temporal, "
            "pinout active3%s\n", width, height, parallel, n_addr, n_planes, n_temporal,
            bgr ? "_bgr" : "");
    return p;
  }

  ~Panel() {
    if (matter_ != NULL) {
      // Black on the glass before the pins go back to inputs (OE then floats: the pull-up on
      // GPIO18, BUILD.md section 4.2, keeps the modules dark). Two refreshes is plenty.
      std::fill(fb_.begin(), fb_.end(), 0);
      matter_->show();
      usleep(50000);
      delete matter_;
    }
  }

  int width() const { return width_; }
  int height() const { return height_; }
  int start_brightness() const { return start_brightness_; }
  int pwm_bits() const { return n_planes_; }
  const char *name() const { return "piomatter"; }

  // Piomatter's own drive curve: gamma 2.2 to 10 bits (colorspace_rgb888's gamma_lut), each set
  // bit lit for its schedule entry's active_time * brightness, truncated to whole pixel clocks
  // exactly as protomatter_render_rgb10 does — so at a low level the shortest planes drop out on
  // the estimate just as they do on the glass. Summed over the temporal sequence.
  void BuildDutyTable() const {
    piomatter::gamma_lut lut(2.2);
    for (int b = 0; b <= 100; ++b) {
      const float bf = PmScale(b);
      double on[10] = {0};
      for (const auto &s : schedules_)
        for (const auto &e : s) {
          const int32_t t = e.active_time * bf;
          if (t > 0 && e.shift < 10) on[e.shift] += t;
        }
      for (int c = 0; c < 256; ++c) {
        const unsigned v = lut.convert((unsigned)c);
        double d = 0;
        for (int k = 0; k < 10; ++k) if (v & (1u << k)) d += on[k];
        duty[b][c] = (float)d;
      }
    }
    full_duty = duty[100][255] ? duty[100][255] : 1;
  }

  // The level goes with the frame: Piomatter reads brightness in show(). 0 sends brightness 0 too
  // (OE held for a few PIO cycles only) on top of the black pixels.
  void BeginFrame(int level) {
    level_ = level;
    std::fill(fb_.begin(), fb_.end(), 0);
  }
  void SetPixel(int x, int y, uint8_t r, uint8_t g, uint8_t b) {
    fb_[(size_t)y * width_ + x] = ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
  }
  void Show() {
    matter_->brightness = PmScale(level_);
    const int err = matter_->show();
    if (err != 0 && err != last_err_)
      fprintf(stderr, "flushBuffer2: Piomatter show: %s\n", strerror(err));
    last_err_ = err;
    if (show_refresh_) {
      // Piomatter measures one refresh of the glass (one pass of the temporal sequence's current
      // step) in its own thread; sampled here once per frame, in hzeller's format so
      // measure-refresh.sh reads it.
      const double hz = matter_->fps;
      if (hz > 0) {
        printf("\b\b\b\b\b\b\b\b%6.1fHz", hz);
        if (lowest_hz_ == 0 || hz < lowest_hz_) { lowest_hz_ = hz; printf(" (lowest: %.1fHz)", hz); }
        fflush(stdout);
      }
    }
  }

 private:
  Panel(int w, int h, int start_brightness, int n_planes, bool show_refresh)
    : width_(w), height_(h), start_brightness_(start_brightness), n_planes_(n_planes),
      show_refresh_(show_refresh), fb_((size_t)w * h, 0) {}
  Panel(const Panel &) = delete;
  Panel &operator=(const Panel &) = delete;

  const int width_, height_, start_brightness_, n_planes_;
  const bool show_refresh_;
  std::vector<uint32_t> fb_;   // 0x00RRGGBB, never resized: Piomatter holds a span of it
  piomatter::piomatter_base *matter_ = NULL;
  piomatter::schedule_sequence schedules_;
  int level_ = 0;
  int last_err_ = 0;
  double lowest_hz_ = 0;
};

#endif  // FLUSHBUFFER_PIOMATTER

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

  Panel *panel = Panel::Create(&argc, &argv);
  if (panel == NULL) { fprintf(stderr, "flushBuffer2: could not init matrix\n"); return 1; }

  signal(SIGTERM, InterruptHandler);
  signal(SIGINT, InterruptHandler);

  const int W = panel->width();
  const int H = panel->height();
  panel->BuildDutyTable();

  char brightness_path[512], power_path[512];
  snprintf(brightness_path, sizeof brightness_path, "%s/brightness", ctl_dir);
  snprintf(power_path, sizeof power_path, "%s/power", ctl_dir);

  // The launch value (setting.ini via startled) is what "no brightness file" means.
  const int start_brightness = panel->start_brightness();
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
               "pid=%d\nstart=%s\ncontrol=brightness power\nbackend=%s\n", (int)getpid(), start_time,
               panel->name());
      if (!WriteSmall(ctl_dir, "driver", text))
        fprintf(stderr, "flushBuffer2: cannot write %s/driver (%s); the appliance will restart "
                "the driver for every brightness change\n", ctl_dir, strerror(errno));
    }
    fprintf(stderr, "flushBuffer2: live control in %s (start brightness %d, %s backend)\n", ctl_dir,
            start_brightness, panel->name());
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

      panel->BeginFrame(level);   // black; at 0 it stays black: dark, and still ours
      if (level >= 1) {
        for (int y = 0; y < chh; ++y) {
          const unsigned char *rowp = px + (size_t)y * w * 3;
          for (int x = 0; x < cw; ++x) {
            const unsigned char *p = rowp + x * 3;
            panel->SetPixel(x, y, p[0], p[1], p[2]);
          }
        }
      }
      stbi_image_free(px);
      panel->Show();

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

  delete panel;
  return 0;
}
