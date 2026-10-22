// Stand-in for stb_image.h, for test/flushbuffer-selftest.mjs: "loads" a binary PPM (P6, maxval
// 255) instead of a PNG, so the test needs neither the real header (fetched by build.sh) nor an
// encoder. Same two calls and the same contract as stb: NULL when the file is missing or short.

#ifndef FAKE_STB_IMAGE_H
#define FAKE_STB_IMAGE_H

#include <stdio.h>
#include <stdlib.h>

static unsigned char *stbi_load(const char *path, int *w, int *h, int *comp, int) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  int max = 0;
  unsigned char *px = NULL;
  if (fscanf(f, "P6 %d %d %d", w, h, &max) == 3 && max == 255 && *w > 0 && *h > 0 && fgetc(f) != EOF) {
    const size_t n = (size_t)*w * *h * 3;
    px = (unsigned char *)malloc(n);
    if (px && fread(px, 1, n, f) != n) { free(px); px = NULL; }
  }
  fclose(f);
  if (px) *comp = 3;
  return px;
}

static void stbi_image_free(void *p) { free(p); }

#endif
