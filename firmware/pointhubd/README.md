# pointhubd

The Point Hub board's hardware service: the only process on its I2C bus. Why it is separate from the
console, and what each part does, is at the top of [`pointhubd.py`](pointhubd.py). Standard library
only. Set up by [`provisioning/point-hub/`](../../provisioning/point-hub/README.md).

```bash
pointhubd.py probe             # which small boards answer (needs no running service)
pointhubd.py ctl status        # what the service sees
pointhubd.py ctl horn 600      # sound the horn; it stops by itself, 5 s at most
python3 -m unittest            # the tests, against simulated chips
```

**It has never run on real chips.** `parse_rdo` and the bus addresses come from the data sheets and
BUILD.md; the first bench run is what proves them.
