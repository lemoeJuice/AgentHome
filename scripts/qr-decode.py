#!/usr/bin/env python3
"""Decode the first QR code from 8-bit RGBA pixels on stdin using ZXing-C++."""

import ctypes
import ctypes.util
import sys


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    width, height = map(int, sys.argv[1:])
    pixels = sys.stdin.buffer.read()
    if width < 1 or height < 1 or len(pixels) != width * height * 4:
        return 2
    library = ctypes.util.find_library("ZXing")
    if not library:
        return 3
    zxing = ctypes.CDLL(library)
    u8ptr = ctypes.POINTER(ctypes.c_uint8)
    zxing.ZXing_ImageView_new_checked.argtypes = [u8ptr, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    zxing.ZXing_ImageView_new_checked.restype = ctypes.c_void_p
    zxing.ZXing_ImageView_delete.argtypes = [ctypes.c_void_p]
    zxing.ZXing_ReaderOptions_new.restype = ctypes.c_void_p
    zxing.ZXing_ReaderOptions_delete.argtypes = [ctypes.c_void_p]
    zxing.ZXing_ReaderOptions_setTryHarder.argtypes = [ctypes.c_void_p, ctypes.c_bool]
    zxing.ZXing_ReaderOptions_setTryRotate.argtypes = [ctypes.c_void_p, ctypes.c_bool]
    zxing.ZXing_ReaderOptions_setFormats.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.c_int]
    zxing.ZXing_BarcodeFormatFromString.argtypes = [ctypes.c_char_p]
    zxing.ZXing_BarcodeFormatFromString.restype = ctypes.c_int
    zxing.ZXing_ReadBarcodes.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    zxing.ZXing_ReadBarcodes.restype = ctypes.c_void_p
    zxing.ZXing_Barcodes_size.argtypes = [ctypes.c_void_p]
    zxing.ZXing_Barcodes_size.restype = ctypes.c_int
    zxing.ZXing_Barcodes_delete.argtypes = [ctypes.c_void_p]
    zxing.ZXing_Barcodes_at.argtypes = [ctypes.c_void_p, ctypes.c_int]
    zxing.ZXing_Barcodes_at.restype = ctypes.c_void_p
    zxing.ZXing_Barcode_isValid.argtypes = [ctypes.c_void_p]
    zxing.ZXing_Barcode_isValid.restype = ctypes.c_bool
    zxing.ZXing_Barcode_text.argtypes = [ctypes.c_void_p]
    zxing.ZXing_Barcode_text.restype = ctypes.c_void_p
    zxing.ZXing_free.argtypes = [ctypes.c_void_p]

    pixel_array = (ctypes.c_uint8 * len(pixels)).from_buffer_copy(pixels)
    image = zxing.ZXing_ImageView_new_checked(pixel_array, len(pixels), width, height, 0x04000102, width * 4, 4)
    options = zxing.ZXing_ReaderOptions_new()
    if not image or not options:
        return 2
    zxing.ZXing_ReaderOptions_setTryHarder(options, True)
    zxing.ZXing_ReaderOptions_setTryRotate(options, True)
    qr_format = ctypes.c_int(zxing.ZXing_BarcodeFormatFromString(b"QRCode"))
    zxing.ZXing_ReaderOptions_setFormats(options, ctypes.byref(qr_format), 1)
    barcodes = zxing.ZXing_ReadBarcodes(image, options)
    try:
        for index in range(zxing.ZXing_Barcodes_size(barcodes)):
            barcode = zxing.ZXing_Barcodes_at(barcodes, index)
            if not zxing.ZXing_Barcode_isValid(barcode):
                continue
            text = zxing.ZXing_Barcode_text(barcode)
            if text:
                try:
                    sys.stdout.buffer.write(ctypes.string_at(text) + b"\n")
                finally:
                    zxing.ZXing_free(text)
                return 0
        return 1
    finally:
        zxing.ZXing_Barcodes_delete(barcodes)
        zxing.ZXing_ReaderOptions_delete(options)
        zxing.ZXing_ImageView_delete(image)


if __name__ == "__main__":
    raise SystemExit(main())
