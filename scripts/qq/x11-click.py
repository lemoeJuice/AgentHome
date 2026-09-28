#!/usr/bin/env python3
"""Send a single X11 left click using the XTest extension."""

import ctypes
import ctypes.util
import os
import sys
import time


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    x, y = map(int, sys.argv[1:])
    x11_name = ctypes.util.find_library("X11")
    xtst_name = ctypes.util.find_library("Xtst")
    if not x11_name or not xtst_name:
        return 3
    x11 = ctypes.CDLL(x11_name)
    xtst = ctypes.CDLL(xtst_name)
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XFlush.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(os.environ.get("DISPLAY", ":1").encode())
    if not display:
        return 4
    xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
    xtst.XTestFakeButtonEvent(display, 1, 1, 0)
    x11.XFlush(display)
    time.sleep(0.08)
    xtst.XTestFakeButtonEvent(display, 1, 0, 0)
    x11.XFlush(display)
    x11.XCloseDisplay(display)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
