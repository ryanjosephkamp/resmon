#!/usr/bin/env python3
"""Offline packaged-runtime voice probe; build preparation is an explicit subcommand.

Never imports resmon, starts a server, or records microphone audio. JSON receipts
separate binary loading, containment, transcription, and deliberate corruption.
Run transcription with the packaged CPython and -I. Build artifacts stay in scratch.
"""

import argparse
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import sys
import sysconfig
import time
import urllib.request
import wave
import zipfile

WHEELS = [{'name': 'pywhispercpp',
  'version': '1.5.1',
  'filename': 'pywhispercpp-1.5.1-cp311-cp311-macosx_11_0_arm64.whl',
  'url': 'https://files.pythonhosted.org/packages/39/b3/72672a83031668b4026b52fb0c0855b43ec0cf84444649d8bf3eef52ec89/pywhispercpp-1.5.1-cp311-cp311-macosx_11_0_arm64.whl',
  'bytes': 4179002,
  'sha256': '4a10b4f9c99123eb6515a98cc972f354d2455884af19856b82cd1c0d6ab2602f',
  'native': [{'bytes': 480064,
              'sha256': 'dcf85f5d6b1536256e7add14bd5d13c83e68333781e363264e2aa479ac8e1b2f',
              'wheel_member': 'libwhisper.1.8.5.dylib',
              'installed': 'libwhisper.1.8.5.dylib'},
             {'bytes': 94784,
              'sha256': '41b92dd3b1aedb0c09af31bd1f02488cebf1f4ed2913b1af6fd74a94fe2d733d',
              'wheel_member': 'libggml.dylib',
              'installed': 'libggml.dylib'},
             {'bytes': 94736,
              'sha256': 'fbacf3d4379716bf5e4cbe5d8c52b51e85d90b485d13580eacb20f4bb097171c',
              'wheel_member': 'libggml.0.dylib',
              'installed': 'libggml.0.dylib'},
             {'bytes': 770264,
              'sha256': '84ea842a75d19ec64dcb268ddfaa2317af010111af9a3ceed7a8a19c41649c97',
              'wheel_member': 'libggml-base.dylib',
              'installed': 'libggml-base.dylib'},
             {'bytes': 76832,
              'sha256': 'c6271a7aedd1bfd9ca00f8f58e57f052efbc5255066da1218d06f3d38a02e589',
              'wheel_member': 'libggml-blas.0.13.1.dylib',
              'installed': 'libggml-blas.0.13.1.dylib'},
             {'bytes': 94736,
              'sha256': 'fbacf3d4379716bf5e4cbe5d8c52b51e85d90b485d13580eacb20f4bb097171c',
              'wheel_member': 'libggml.0.13.1.dylib',
              'installed': 'libggml.0.13.1.dylib'},
             {'bytes': 829504,
              'sha256': 'e6a59aa0dbefc9c64daa3e8d9e12dad9328ecc7dcd42a80b70bd309d661638d3',
              'wheel_member': 'libggml-cpu.0.13.1.dylib',
              'installed': 'libggml-cpu.0.13.1.dylib'},
             {'bytes': 76880,
              'sha256': '945ea5ea538937370e818f15f1e00b8bbebd50e031a3977bf916cb002238a253',
              'wheel_member': 'libggml-blas.dylib',
              'installed': 'libggml-blas.dylib'},
             {'bytes': 850000,
              'sha256': '701367f152864e547518dcf7e32a16cfbc07d88b490e3b395a8d0b3d29ffba02',
              'wheel_member': 'libggml-metal.0.dylib',
              'installed': 'libggml-metal.0.dylib'},
             {'bytes': 850000,
              'sha256': '701367f152864e547518dcf7e32a16cfbc07d88b490e3b395a8d0b3d29ffba02',
              'wheel_member': 'libggml-metal.0.13.1.dylib',
              'installed': 'libggml-metal.0.13.1.dylib'},
             {'bytes': 829552,
              'sha256': '08617de8853bffd1e2dbd45ef21c70d1ec10b4b79a46db05a1b225dc2e7a7cb8',
              'wheel_member': 'libggml-cpu.dylib',
              'installed': 'libggml-cpu.dylib'},
             {'bytes': 850048,
              'sha256': '2fcc3f71835997d853900ad8759d34145607f62de99faa3a85450e934c3bca20',
              'wheel_member': 'libggml-metal.dylib',
              'installed': 'libggml-metal.dylib'},
             {'bytes': 480112,
              'sha256': 'fc56ee1f1fb9ca5e14b82f4a80194e96a3c1c6351a5a3fc14d732b6ea9b141b5',
              'wheel_member': 'libwhisper.dylib',
              'installed': 'libwhisper.dylib'},
             {'bytes': 480064,
              'sha256': 'dcf85f5d6b1536256e7add14bd5d13c83e68333781e363264e2aa479ac8e1b2f',
              'wheel_member': 'libwhisper.1.dylib',
              'installed': 'libwhisper.1.dylib'},
             {'bytes': 770264,
              'sha256': '84ea842a75d19ec64dcb268ddfaa2317af010111af9a3ceed7a8a19c41649c97',
              'wheel_member': 'libggml-base.0.13.1.dylib',
              'installed': 'libggml-base.0.13.1.dylib'},
             {'bytes': 462064,
              'sha256': '637433fe242d9932db2e3a3f490317abc757f907b8f5b28f8668668bc23c7c12',
              'wheel_member': '_pywhispercpp.cpython-311-darwin.so',
              'installed': '_pywhispercpp.cpython-311-darwin.so'},
             {'bytes': 770264,
              'sha256': '84ea842a75d19ec64dcb268ddfaa2317af010111af9a3ceed7a8a19c41649c97',
              'wheel_member': 'libggml-base.0.dylib',
              'installed': 'libggml-base.0.dylib'},
             {'bytes': 76832,
              'sha256': 'c6271a7aedd1bfd9ca00f8f58e57f052efbc5255066da1218d06f3d38a02e589',
              'wheel_member': 'libggml-blas.0.dylib',
              'installed': 'libggml-blas.0.dylib'},
             {'bytes': 829504,
              'sha256': 'e6a59aa0dbefc9c64daa3e8d9e12dad9328ecc7dcd42a80b70bd309d661638d3',
              'wheel_member': 'libggml-cpu.0.dylib',
              'installed': 'libggml-cpu.0.dylib'},
             {'bytes': 480064,
              'sha256': '2db2b98bdc61b849d25842205dd97a5ea9ad9f4a9e50763be228514a5598782a',
              'wheel_member': 'pywhispercpp/.dylibs/libwhisper.1.8.5.dylib',
              'installed': 'pywhispercpp/.dylibs/libwhisper.1.8.5.dylib'},
             {'bytes': 76832,
              'sha256': '3e92a4557ff1a3f4c0983c953ca3d91951ff2cf3b7b8bd1bc6aff7e225f1f08e',
              'wheel_member': 'pywhispercpp/.dylibs/libggml-blas.0.13.1.dylib',
              'installed': 'pywhispercpp/.dylibs/libggml-blas.0.13.1.dylib'},
             {'bytes': 94736,
              'sha256': '307062b3098d363c4dacdf4c8b2c8e9fc0e8f34ea22b76a1acb68bce6c54a5ca',
              'wheel_member': 'pywhispercpp/.dylibs/libggml.0.13.1.dylib',
              'installed': 'pywhispercpp/.dylibs/libggml.0.13.1.dylib'},
             {'bytes': 829504,
              'sha256': '41ae10229276291dc325fe280fb815d3ee272fe2a3638d3eef5139ce2f29d1bc',
              'wheel_member': 'pywhispercpp/.dylibs/libggml-cpu.0.13.1.dylib',
              'installed': 'pywhispercpp/.dylibs/libggml-cpu.0.13.1.dylib'},
             {'bytes': 850000,
              'sha256': '98d5f6b397848b951c43b945d29d743375d2d124ec4889cef2acd49acc4bc128',
              'wheel_member': 'pywhispercpp/.dylibs/libggml-metal.0.13.1.dylib',
              'installed': 'pywhispercpp/.dylibs/libggml-metal.0.13.1.dylib'},
             {'bytes': 788352,
              'sha256': 'f35e025586d0cfa826ab68269bab8c3822e6e66982cd67982d6fe92d98c8bf10',
              'wheel_member': 'pywhispercpp/.dylibs/libggml-base.0.13.1.dylib',
              'installed': 'pywhispercpp/.dylibs/libggml-base.0.13.1.dylib'}]},
 {'name': 'pywhispercpp',
  'version': '1.5.1',
  'filename': 'pywhispercpp-1.5.1-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl',
  'url': 'https://files.pythonhosted.org/packages/72/dc/fb7a441ea45bcc3449f06ad3d6f7f8c6c0705e4a3d62a70f0635c83481b7/pywhispercpp-1.5.1-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl',
  'bytes': 4673602,
  'sha256': 'a70839d9a1f569e1e5424f27ed01a32133d658beae4cd1459eb39de1e0483bba',
  'native': [{'bytes': 540649,
              'sha256': 'b09c33e75a352649be84fbb7efae484a149f95ac2f8c09ac7d77264ae8b938d0',
              'wheel_member': '_pywhispercpp.cpython-311-x86_64-linux-gnu.so',
              'installed': '_pywhispercpp.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 911257,
              'sha256': '8c0f6278fef6393e17c66fa7f280958488de1cda008a602080557d024c1bcd8e',
              'wheel_member': 'libggml-base.so',
              'installed': 'libggml-base.so'},
             {'bytes': 911257,
              'sha256': '8c0f6278fef6393e17c66fa7f280958488de1cda008a602080557d024c1bcd8e',
              'wheel_member': 'libggml-base.so.0',
              'installed': 'libggml-base.so.0'},
             {'bytes': 911257,
              'sha256': '8c0f6278fef6393e17c66fa7f280958488de1cda008a602080557d024c1bcd8e',
              'wheel_member': 'libggml-base.so.0.13.1',
              'installed': 'libggml-base.so.0.13.1'},
             {'bytes': 1078193,
              'sha256': 'dcfaf0ae49e05efd811b847a55f36116421b0551724d663a29d69bd3b79c2d12',
              'wheel_member': 'libggml-cpu.so',
              'installed': 'libggml-cpu.so'},
             {'bytes': 1078193,
              'sha256': 'dcfaf0ae49e05efd811b847a55f36116421b0551724d663a29d69bd3b79c2d12',
              'wheel_member': 'libggml-cpu.so.0',
              'installed': 'libggml-cpu.so.0'},
             {'bytes': 1078193,
              'sha256': 'dcfaf0ae49e05efd811b847a55f36116421b0551724d663a29d69bd3b79c2d12',
              'wheel_member': 'libggml-cpu.so.0.13.1',
              'installed': 'libggml-cpu.so.0.13.1'},
             {'bytes': 319705,
              'sha256': '161f023904ab244496fd0b341c6d22f2180196cb801e1fe9df5a7a196ce2f00c',
              'wheel_member': 'libggml.so',
              'installed': 'libggml.so'},
             {'bytes': 319705,
              'sha256': '161f023904ab244496fd0b341c6d22f2180196cb801e1fe9df5a7a196ce2f00c',
              'wheel_member': 'libggml.so.0',
              'installed': 'libggml.so.0'},
             {'bytes': 319705,
              'sha256': '161f023904ab244496fd0b341c6d22f2180196cb801e1fe9df5a7a196ce2f00c',
              'wheel_member': 'libggml.so.0.13.1',
              'installed': 'libggml.so.0.13.1'},
             {'bytes': 694569,
              'sha256': '06b971bddd423123a6c17c69e9b2b39997d440a7db16be99f564adba23d2fa63',
              'wheel_member': 'libwhisper.so',
              'installed': 'libwhisper.so'},
             {'bytes': 694569,
              'sha256': '06b971bddd423123a6c17c69e9b2b39997d440a7db16be99f564adba23d2fa63',
              'wheel_member': 'libwhisper.so.1',
              'installed': 'libwhisper.so.1'},
             {'bytes': 694569,
              'sha256': '06b971bddd423123a6c17c69e9b2b39997d440a7db16be99f564adba23d2fa63',
              'wheel_member': 'libwhisper.so.1.8.5',
              'installed': 'libwhisper.so.1.8.5'},
             {'bytes': 339601,
              'sha256': '67b9b51741d7f7fd806c7b032744bd4a0592c79d1218ffe1c67a3aafddf6431d',
              'wheel_member': 'pywhispercpp.libs/libggml-684d824a.so.0.13.1',
              'installed': 'pywhispercpp.libs/libggml-684d824a.so.0.13.1'},
             {'bytes': 939385,
              'sha256': 'b764c1371a3cdcc13425498627e72f68395a04bed2eccfab8d6b3be158cb4599',
              'wheel_member': 'pywhispercpp.libs/libggml-base-319ad4fb.so.0.13.1',
              'installed': 'pywhispercpp.libs/libggml-base-319ad4fb.so.0.13.1'},
             {'bytes': 1110377,
              'sha256': 'c5285be1d364b7f798040e3114602bfff89b0f6913dcba42ce10c9621b7774f0',
              'wheel_member': 'pywhispercpp.libs/libggml-cpu-67036419.so.0.13.1',
              'installed': 'pywhispercpp.libs/libggml-cpu-67036419.so.0.13.1'},
             {'bytes': 253289,
              'sha256': 'a43904e4fa297301d4640dc1bb3c8a3480b406f99e498eba9b1914b68aab604a',
              'wheel_member': 'pywhispercpp.libs/libgomp-e985bcbb.so.1.0.0',
              'installed': 'pywhispercpp.libs/libgomp-e985bcbb.so.1.0.0'},
             {'bytes': 734929,
              'sha256': 'a6701948b8d7b58572bd380cca936af569fd182546fc86795f2dc6d34700b1d4',
              'wheel_member': 'pywhispercpp.libs/libwhisper-1ab89ae8.so.1.8.5',
              'installed': 'pywhispercpp.libs/libwhisper-1ab89ae8.so.1.8.5'}]},
 {'name': 'pywhispercpp',
  'version': '1.5.1',
  'filename': 'pywhispercpp-1.5.1-cp311-cp311-win_amd64.whl',
  'url': 'https://files.pythonhosted.org/packages/6d/c8/14c922c2b57a7b0ad4a587931b1ba13868f675a51db1f3d1f6e970b4ed2f/pywhispercpp-1.5.1-cp311-cp311-win_amd64.whl',
  'bytes': 1374701,
  'sha256': '539fbdc7de1348f16c1fb18802a025bf07340b5f7de1699ff8f7cb60be063145',
  'native': [{'bytes': 394752,
              'sha256': '1bfaa398c9cdb0777d6ac20ccc2062d6fbebf3439b65140d3909b9bb03bae4d6',
              'wheel_member': '_pywhispercpp.cp311-win_amd64.pyd',
              'installed': '_pywhispercpp.cp311-win_amd64.pyd'},
             {'bytes': 67072,
              'sha256': '3974600f37997d535a78c3503d9eec1f6110cf52024857617d293f7d8945e7f9',
              'wheel_member': 'pywhispercpp-1.5.1.data/platlib/ggml-1e032c08db5e0e15c29ea04244293a33.dll',
              'installed': 'ggml-1e032c08db5e0e15c29ea04244293a33.dll'},
             {'bytes': 638464,
              'sha256': '697809bfe3c7681dc845940b44c0cc39c9c10da6d16a66df1af1603cf52a7203',
              'wheel_member': 'pywhispercpp-1.5.1.data/platlib/ggml-base-0e272b71f72b021714eb3387b9be91c6.dll',
              'installed': 'ggml-base-0e272b71f72b021714eb3387b9be91c6.dll'},
             {'bytes': 785408,
              'sha256': 'e911ae323d8dc5a5bae7f38039d73efb923dc37b41a599cec1bcac3a3d70d81a',
              'wheel_member': 'pywhispercpp-1.5.1.data/platlib/ggml-cpu-9a43108c31d9a3a1442cbc954beab8c4.dll',
              'installed': 'ggml-cpu-9a43108c31d9a3a1442cbc954beab8c4.dll'},
             {'bytes': 575056,
              'sha256': 'a4c2229bdc2a2a630acdc095b4d86008e5c3e3bc7773174354f3da4f5beb9cde',
              'wheel_member': 'pywhispercpp-1.5.1.data/platlib/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll',
              'installed': 'msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll'},
             {'bytes': 213072,
              'sha256': 'f96f3a14d88d8846f31f3ab38a490304ce7d6e4f70fae4304c63e59c7aea2d30',
              'wheel_member': 'pywhispercpp-1.5.1.data/platlib/vcomp140-f96f3a14d88d8846f31f3ab38a490304.dll',
              'installed': 'vcomp140-f96f3a14d88d8846f31f3ab38a490304.dll'},
             {'bytes': 1308160,
              'sha256': '509f9f1a66773de73e5ce40348549f6cb5585c8e334d0a38c6a4f4815378c1ed',
              'wheel_member': 'pywhispercpp-1.5.1.data/platlib/whisper-deb191d593e4e34d60fc6bb1108139b2.dll',
              'installed': 'whisper-deb191d593e4e34d60fc6bb1108139b2.dll'}]},
 {'name': 'pywhispercpp',
  'version': '1.2.0',
  'filename': 'pywhispercpp-1.2.0-cp311-cp311-macosx_10_9_x86_64.whl',
  'url': 'https://files.pythonhosted.org/packages/a3/16/5b691d6846c3665d856ef58d92426f94c5395e7f8632d39bf74386b62a2a/pywhispercpp-1.2.0-cp311-cp311-macosx_10_9_x86_64.whl',
  'bytes': 948321,
  'sha256': '7eb33365165424b3d023ca901f1f88bc6fb54fc9acf2d1992f6ff4876de83c6e',
  'native': [{'bytes': 987760,
              'sha256': '7474989e150d43b0df131592ae086620c94eaf01978a93764c62c8905be76771',
              'wheel_member': 'libwhisper.dylib',
              'installed': 'libwhisper.dylib'},
             {'bytes': 274176,
              'sha256': '08761a3713618ad7faa716ccfbb76bdf59f97c81d2a6c02d4e563f4fd5be0ddc',
              'wheel_member': '_pywhispercpp.cpython-311-darwin.so',
              'installed': '_pywhispercpp.cpython-311-darwin.so'},
             {'bytes': 1018800,
              'sha256': 'c4248a8fb3422d5be7597ffb4daaec3d50961cbdafbdce9f4c7f807ac6a6bb3f',
              'wheel_member': 'pywhispercpp/.dylibs/libwhisper.dylib',
              'installed': 'pywhispercpp/.dylibs/libwhisper.dylib'}]},
 {'name': 'numpy',
  'version': '1.26.4',
  'filename': 'numpy-1.26.4-cp311-cp311-macosx_10_9_x86_64.whl',
  'url': 'https://files.pythonhosted.org/packages/11/57/baae43d14fe163fa0e4c47f307b6b2511ab8d7d30177c491960504252053/numpy-1.26.4-cp311-cp311-macosx_10_9_x86_64.whl',
  'bytes': 20630554,
  'sha256': '4c66707fabe114439db9068ee468c26bbdf909cac0fb58686a42a24de1760c71',
  'native': [{'bytes': 5561424,
              'sha256': 'd65440d0d2907516e0e1fda8a30d203101e6b46c6a1c2dc58fe7fcf962ef2b40',
              'wheel_member': 'numpy/core/_multiarray_umath.cpython-311-darwin.so',
              'installed': 'numpy/core/_multiarray_umath.cpython-311-darwin.so'},
             {'bytes': 2582952,
              'sha256': '618e6bb41a01a7a513b6d8aaa10be428a2d9c3ddb78ab27d327466b72c0e44ce',
              'wheel_member': 'numpy/core/_simd.cpython-311-darwin.so',
              'installed': 'numpy/core/_simd.cpython-311-darwin.so'},
             {'bytes': 54840,
              'sha256': '6e15d45b7df03fde5778f01a767e13f4ad5cf9a3103dfa309b53675fa31ec37f',
              'wheel_member': 'numpy/core/_umath_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_umath_tests.cpython-311-darwin.so'},
             {'bytes': 122024,
              'sha256': '04b3816b6fb89a171510a1208d75434256f69c8e0865c5177e5676312498fe83',
              'wheel_member': 'numpy/core/_multiarray_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_multiarray_tests.cpython-311-darwin.so'},
             {'bytes': 34056,
              'sha256': '214191861d3521534fe2643f678783226af73f2d81940d1b5be4ec943166badc',
              'wheel_member': 'numpy/core/_operand_flag_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_operand_flag_tests.cpython-311-darwin.so'},
             {'bytes': 72136,
              'sha256': 'a1f579a94ffc7c84fc53d03bfda0b3986dbb875d04fd5ae42e6e4fc406907fc1',
              'wheel_member': 'numpy/core/_rational_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_rational_tests.cpython-311-darwin.so'},
             {'bytes': 34312,
              'sha256': 'e5fafc97701545b98bce6e2ef86b4cf289c638cdfd25ba25df387dfce0be8a3c',
              'wheel_member': 'numpy/core/_struct_ufunc_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_struct_ufunc_tests.cpython-311-darwin.so'},
             {'bytes': 54512,
              'sha256': 'c995d5da2a8b73d6db5b545f2563833e7f0cc85d71c86d7cf7c2742c7a7d6f2d',
              'wheel_member': 'numpy/linalg/lapack_lite.cpython-311-darwin.so',
              'installed': 'numpy/linalg/lapack_lite.cpython-311-darwin.so'},
             {'bytes': 224400,
              'sha256': '06917e629daf13a1c140082850c1e61b5dcfc595acbfcff93f440a8665bbb002',
              'wheel_member': 'numpy/linalg/_umath_linalg.cpython-311-darwin.so',
              'installed': 'numpy/linalg/_umath_linalg.cpython-311-darwin.so'},
             {'bytes': 6786304,
              'sha256': '004e1800141f5159cf4b14006af30139147627f0a7886ddf2ebf08e4f61719d9',
              'wheel_member': 'numpy/.dylibs/libgfortran.5.dylib',
              'installed': 'numpy/.dylibs/libgfortran.5.dylib'},
             {'bytes': 352704,
              'sha256': 'd290435604ce2ba8d1969ef6c46566689f543ef07a927d764500cc5eec78b761',
              'wheel_member': 'numpy/.dylibs/libquadmath.0.dylib',
              'installed': 'numpy/.dylibs/libquadmath.0.dylib'},
             {'bytes': 138704,
              'sha256': 'c09af95565433e66b4432a1e59aa6c1debe5b8af8908b5f1f89bbd7fea30b114',
              'wheel_member': 'numpy/.dylibs/libgcc_s.1.1.dylib',
              'installed': 'numpy/.dylibs/libgcc_s.1.1.dylib'},
             {'bytes': 69339728,
              'sha256': '7989f7da454076b55824c0eb64b9d57e5553439e0450f719b386aa19c251fbc1',
              'wheel_member': 'numpy/.dylibs/libopenblas64_.0.dylib',
              'installed': 'numpy/.dylibs/libopenblas64_.0.dylib'},
             {'bytes': 101352,
              'sha256': 'cc9190f9e8d4917fcf9b979a9ad046fee76a2a0ecdf5d466cb17f08f06f768a8',
              'wheel_member': 'numpy/fft/_pocketfft_internal.cpython-311-darwin.so',
              'installed': 'numpy/fft/_pocketfft_internal.cpython-311-darwin.so'},
             {'bytes': 868080,
              'sha256': '52dfc02fbcef2e260fdf24b6093324aad906c971f5cf2fb050e8952b1efc9829',
              'wheel_member': 'numpy/random/_generator.cpython-311-darwin.so',
              'installed': 'numpy/random/_generator.cpython-311-darwin.so'},
             {'bytes': 250624,
              'sha256': 'b8e1f7366916e519c431150cd64ef52914de0164abae80c77d95c3b7c4872bce',
              'wheel_member': 'numpy/random/_common.cpython-311-darwin.so',
              'installed': 'numpy/random/_common.cpython-311-darwin.so'},
             {'bytes': 739520,
              'sha256': '264bdff0dda96ae7b9fec4536c823fece79c8a2869675abaf4f3e83f1c66bb75',
              'wheel_member': 'numpy/random/mtrand.cpython-311-darwin.so',
              'installed': 'numpy/random/mtrand.cpython-311-darwin.so'},
             {'bytes': 78000,
              'sha256': 'a31ade3a5785a44953178d3cd3db567289ed44a91d9bc1ed78f6caa9cd6e793a',
              'wheel_member': 'numpy/random/_sfc64.cpython-311-darwin.so',
              'installed': 'numpy/random/_sfc64.cpython-311-darwin.so'},
             {'bytes': 115472,
              'sha256': 'b89a9089cac6eca3d5bd06ecf7da5f80b67af1dc7db6fa42005b4c73a5e6b56a',
              'wheel_member': 'numpy/random/_pcg64.cpython-311-darwin.so',
              'installed': 'numpy/random/_pcg64.cpython-311-darwin.so'},
             {'bytes': 96752,
              'sha256': 'e3e8b5463df6d0bee8ef2be349db65295a047e6399d211e63bd081cb1a995243',
              'wheel_member': 'numpy/random/_philox.cpython-311-darwin.so',
              'installed': 'numpy/random/_philox.cpython-311-darwin.so'},
             {'bytes': 113376,
              'sha256': '448692f2c62f961abff65099ee403d29f69254ef2ce91cfd3f2cbd950e2c4bb0',
              'wheel_member': 'numpy/random/_mt19937.cpython-311-darwin.so',
              'installed': 'numpy/random/_mt19937.cpython-311-darwin.so'},
             {'bytes': 409832,
              'sha256': '80b38a29377fad9cd42742f3309910381aed20a3ff99a72cac85ba6a6cef2e35',
              'wheel_member': 'numpy/random/_bounded_integers.cpython-311-darwin.so',
              'installed': 'numpy/random/_bounded_integers.cpython-311-darwin.so'},
             {'bytes': 217960,
              'sha256': 'a232d888f6dbff7e5b0741ba29323067c04197986e27d4f858a52ab0f81971cd',
              'wheel_member': 'numpy/random/bit_generator.cpython-311-darwin.so',
              'installed': 'numpy/random/bit_generator.cpython-311-darwin.so'}]},
 {'name': 'numpy',
  'version': '1.26.4',
  'filename': 'numpy-1.26.4-cp311-cp311-macosx_11_0_arm64.whl',
  'url': 'https://files.pythonhosted.org/packages/1a/2e/151484f49fd03944c4a3ad9c418ed193cfd02724e138ac8a9505d056c582/numpy-1.26.4-cp311-cp311-macosx_11_0_arm64.whl',
  'bytes': 13997127,
  'sha256': 'edd8b5fe47dab091176d21bb6de568acdd906d1887a4584a15a9a96a1dca06ef',
  'native': [{'bytes': 3164400,
              'sha256': '6a88945aed63a76e3c57076d657d704eef5d0d1e8d6cb1576724b1deb2872e44',
              'wheel_member': 'numpy/core/_multiarray_umath.cpython-311-darwin.so',
              'installed': 'numpy/core/_multiarray_umath.cpython-311-darwin.so'},
             {'bytes': 339720,
              'sha256': '1e9e7fc175205ff6bfed7a8b6a66340d9cadaf5f79296e7b418520aa6a4d0256',
              'wheel_member': 'numpy/core/_simd.cpython-311-darwin.so',
              'installed': 'numpy/core/_simd.cpython-311-darwin.so'},
             {'bytes': 70847,
              'sha256': '89563edf14f198a0f32930c7421368603e7c606413fa600df87636f7128f91d4',
              'wheel_member': 'numpy/core/_umath_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_umath_tests.cpython-311-darwin.so'},
             {'bytes': 122468,
              'sha256': '41765b1f82b790796700b74e499f901438613a54fcd5301d7bba6e6c3e8f83cf',
              'wheel_member': 'numpy/core/_multiarray_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_multiarray_tests.cpython-311-darwin.so'},
             {'bytes': 50982,
              'sha256': '00be53412296517a1a11b8034d39d05cbfc497f5e05febcca9b1988637ec93a4',
              'wheel_member': 'numpy/core/_operand_flag_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_operand_flag_tests.cpython-311-darwin.so'},
             {'bytes': 72674,
              'sha256': '5ddfbcce7571442b17f7c87482de53494d028958ac1a465055d206a7ac6fd8eb',
              'wheel_member': 'numpy/core/_rational_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_rational_tests.cpython-311-darwin.so'},
             {'bytes': 51270,
              'sha256': '52e4b7e8c85670ba55a3ddae26984407236c1095b6a9ea37ca7fb0a22368ca55',
              'wheel_member': 'numpy/core/_struct_ufunc_tests.cpython-311-darwin.so',
              'installed': 'numpy/core/_struct_ufunc_tests.cpython-311-darwin.so'},
             {'bytes': 70640,
              'sha256': 'cbb2d8f5f5b3945452c2a2f218bbfe9fb6b0392593c39dba76812228eaad464d',
              'wheel_member': 'numpy/linalg/lapack_lite.cpython-311-darwin.so',
              'installed': 'numpy/linalg/lapack_lite.cpython-311-darwin.so'},
             {'bytes': 173040,
              'sha256': 'd21ca7a4becb93fcad2a4c3d378cfae29c9d35d1505426e56cfd06d4f69d8804',
              'wheel_member': 'numpy/linalg/_umath_linalg.cpython-311-darwin.so',
              'installed': 'numpy/linalg/_umath_linalg.cpython-311-darwin.so'},
             {'bytes': 3700784,
              'sha256': '5eb02fa55064ff8ae537dbdb1b0ae0b2175c845adbba089bd44616c06ec321eb',
              'wheel_member': 'numpy/.dylibs/libgfortran.5.dylib',
              'installed': 'numpy/.dylibs/libgfortran.5.dylib'},
             {'bytes': 371440,
              'sha256': '1b341ae276c4adcb30c070b774ec6e68e819c883e897f0de8941d553f7989a0d',
              'wheel_member': 'numpy/.dylibs/libquadmath.0.dylib',
              'installed': 'numpy/.dylibs/libquadmath.0.dylib'},
             {'bytes': 158976,
              'sha256': 'baee2e6118dd54c0852f881d718516d70884de84bfaa085de5d8d8f90baa3b06',
              'wheel_member': 'numpy/.dylibs/libgcc_s.1.1.dylib',
              'installed': 'numpy/.dylibs/libgcc_s.1.1.dylib'},
             {'bytes': 23198400,
              'sha256': 'dde2b735d01caa531885115ea853b5a4172b935167b95a1acb2a10243e0d97e7',
              'wheel_member': 'numpy/.dylibs/libopenblas64_.0.dylib',
              'installed': 'numpy/.dylibs/libopenblas64_.0.dylib'},
             {'bytes': 102310,
              'sha256': 'd830a065614a02df717ccc0e7560ac297b9d16caae4b06a0409eadc036413a33',
              'wheel_member': 'numpy/fft/_pocketfft_internal.cpython-311-darwin.so',
              'installed': 'numpy/fft/_pocketfft_internal.cpython-311-darwin.so'},
             {'bytes': 826877,
              'sha256': '22cb7220d2c4739dff165ad6012f987f3a320893487e8621276dc4acf056f994',
              'wheel_member': 'numpy/random/_generator.cpython-311-darwin.so',
              'installed': 'numpy/random/_generator.cpython-311-darwin.so'},
             {'bytes': 250698,
              'sha256': 'e140b1190693530ad4a53c9c6a7c0cb242259786bb4151655a2843a11c5f2bc7',
              'wheel_member': 'numpy/random/_common.cpython-311-darwin.so',
              'installed': 'numpy/random/_common.cpython-311-darwin.so'},
             {'bytes': 700233,
              'sha256': '7a7a28931b6e6c42c9bd6d590ec19c90f17b4dc32f5114a269488227495480c2',
              'wheel_member': 'numpy/random/mtrand.cpython-311-darwin.so',
              'installed': 'numpy/random/mtrand.cpython-311-darwin.so'},
             {'bytes': 93529,
              'sha256': '3b8e220851c3fce81151fe6707cedcecaa253ce0e1910696e5161c754abe65b2',
              'wheel_member': 'numpy/random/_sfc64.cpython-311-darwin.so',
              'installed': 'numpy/random/_sfc64.cpython-311-darwin.so'},
             {'bytes': 129321,
              'sha256': 'a474b7ae5824d839a051c47c7754ed574d2c29029e268ca2e2ded75c44edd531',
              'wheel_member': 'numpy/random/_pcg64.cpython-311-darwin.so',
              'installed': 'numpy/random/_pcg64.cpython-311-darwin.so'},
             {'bytes': 111770,
              'sha256': '6412df9e9cdad606e05923378c315446e929d4bc18c56ec3c6b8cb03b9dabdf6',
              'wheel_member': 'numpy/random/_philox.cpython-311-darwin.so',
              'installed': 'numpy/random/_philox.cpython-311-darwin.so'},
             {'bytes': 112379,
              'sha256': '9af2dfe8ca9c2d84b3d04b3515d3c43c77ba0516f99c947c03fcbb207b754468',
              'wheel_member': 'numpy/random/_mt19937.cpython-311-darwin.so',
              'installed': 'numpy/random/_mt19937.cpython-311-darwin.so'},
             {'bytes': 364692,
              'sha256': '19c90438cc91320903dfd012aa1daf07823309c8d80ed60af215ce2e497b57f7',
              'wheel_member': 'numpy/random/_bounded_integers.cpython-311-darwin.so',
              'installed': 'numpy/random/_bounded_integers.cpython-311-darwin.so'},
             {'bytes': 207824,
              'sha256': '0e297e277c708471e140c9b1250329941266c2a5dfef39d40979cbec80e1499d',
              'wheel_member': 'numpy/random/bit_generator.cpython-311-darwin.so',
              'installed': 'numpy/random/bit_generator.cpython-311-darwin.so'}]},
 {'name': 'numpy',
  'version': '1.26.4',
  'filename': 'numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
  'url': 'https://files.pythonhosted.org/packages/3a/d0/edc009c27b406c4f9cbc79274d6e46d634d139075492ad055e3d68445925/numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
  'bytes': 18252005,
  'sha256': '666dbfb6ec68962c033a450943ded891bed2d54e6755e35e5835d63f4f6931d5',
  'native': [{'bytes': 97008,
              'sha256': '5f36850f3c48eacf11a9d1e3b5957a36b2b7dd3eb7d21f68c1017cfab4fd0006',
              'wheel_member': 'numpy/fft/_pocketfft_internal.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/fft/_pocketfft_internal.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 216793,
              'sha256': '0587df84ed9751090867a4a1441d2c394c39735420aa388b8bf698b7255f24bd',
              'wheel_member': 'numpy/linalg/_umath_linalg.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/linalg/_umath_linalg.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 29849,
              'sha256': 'cd61ec2267130b112465bc85dab82b7254530f3cf913ba688833b084e29a551b',
              'wheel_member': 'numpy/linalg/lapack_lite.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/linalg/lapack_lite.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 76760,
              'sha256': '23bc5f7b1001a6ce6eb20fcad0d68885d9da3fa6d2857eb15c37eb6e9c779431',
              'wheel_member': 'numpy/random/_sfc64.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/_sfc64.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 242584,
              'sha256': 'b4498c107393d71027b88b81505ba7b00591b1085dab86f08262ca675407a990',
              'wheel_member': 'numpy/random/bit_generator.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/bit_generator.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 120312,
              'sha256': 'd39b0e5a9e90613deede597857f8abec29cfb2ccccaff6ed6f11cbc10f684a82',
              'wheel_member': 'numpy/random/_mt19937.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/_mt19937.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 379288,
              'sha256': 'f1c44733f16f7b1be33ba0c888a2a2a231078cf650f403c4f6ee20a129c2add5',
              'wheel_member': 'numpy/random/_bounded_integers.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/_bounded_integers.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 107480,
              'sha256': '0b00972840c5eb3c0daac37fc35c66b16573ee31a5c0590cf2f928b025cd6a92',
              'wheel_member': 'numpy/random/_philox.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/_philox.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 272272,
              'sha256': 'eadcee6d2cdfd7ce294cb69554c410d8dc9d7457f6ba862bf4e9d5d7f2851f9c',
              'wheel_member': 'numpy/random/_common.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/_common.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 783904,
              'sha256': '2ef986be94cc5ed1acad874d323f864a9c0f88a0c4dd2b171dafb512c0aca496',
              'wheel_member': 'numpy/random/mtrand.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/mtrand.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 980520,
              'sha256': '8c23f8e487f474185f11f28fc7b8eb2ebbc60712f68c3eb5f3cf014f2c7ec46c',
              'wheel_member': 'numpy/random/_generator.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/_generator.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 126448,
              'sha256': 'c617a5a7ec182d04e3c2baf93e505705af32ac410d0f332c857536d473c32793',
              'wheel_member': 'numpy/random/_pcg64.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/random/_pcg64.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 42272,
              'sha256': '1bfd698ea597d3013e08163509e59d7ef68734611f3911268099331533585fd4',
              'wheel_member': 'numpy/core/_umath_tests.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/core/_umath_tests.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 16960,
              'sha256': '092943679822d35239bfe37b8c7bd27d12f2389491f4931c215d9c22ae489c6a',
              'wheel_member': 'numpy/core/_struct_ufunc_tests.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/core/_struct_ufunc_tests.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 59768,
              'sha256': '261983ca4748f49fe1c7fb30cb8d94c5e1631460c5f8c123eaede328bdf6efbd',
              'wheel_member': 'numpy/core/_rational_tests.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/core/_rational_tests.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 175912,
              'sha256': '7c4195087f00564c13cd7e3b5682bef7eb2059e51acc3c17450c0ee4650aeabf',
              'wheel_member': 'numpy/core/_multiarray_tests.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/core/_multiarray_tests.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 16856,
              'sha256': '7d2b2b728d4abaddd4686659e5ffb0f603b0ea28a5e2fe5eb388748e3b203347',
              'wheel_member': 'numpy/core/_operand_flag_tests.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/core/_operand_flag_tests.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 3527040,
              'sha256': 'abff6287d5a407977dc9db05014e6548e1f54a7c4f21dee319819c49bb6bc532',
              'wheel_member': 'numpy/core/_simd.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/core/_simd.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 7426817,
              'sha256': 'a735e4e8355b75c800112af8a5b1731b891b2016ed57067352eea6cab0aa00bc',
              'wheel_member': 'numpy/core/_multiarray_umath.cpython-311-x86_64-linux-gnu.so',
              'installed': 'numpy/core/_multiarray_umath.cpython-311-x86_64-linux-gnu.so'},
             {'bytes': 35123345,
              'sha256': '9254d0854dd7615e11de28d771ae408878ca8123a7ac204f21e4cc7a376cc2e5',
              'wheel_member': 'numpy.libs/libopenblas64_p-r0-0cf96a72.3.23.dev.so',
              'installed': 'numpy.libs/libopenblas64_p-r0-0cf96a72.3.23.dev.so'},
             {'bytes': 247609,
              'sha256': '934c22ded0e7d169c4d4678876c96051adf3d94545da962f60b41659b075da3b',
              'wheel_member': 'numpy.libs/libquadmath-96973f99.so.0.0.0',
              'installed': 'numpy.libs/libquadmath-96973f99.so.0.0.0'},
             {'bytes': 2686065,
              'sha256': '14afb3129b1a8b50bc40a3b0820c7f1152ea9bc10121aab152943f7057472886',
              'wheel_member': 'numpy.libs/libgfortran-040039e1.so.5.0.0',
              'installed': 'numpy.libs/libgfortran-040039e1.so.5.0.0'}]},
 {'name': 'numpy',
  'version': '1.26.4',
  'filename': 'numpy-1.26.4-cp311-cp311-win_amd64.whl',
  'url': 'https://files.pythonhosted.org/packages/3f/6b/5610004206cf7f8e7ad91c5a85a8c71b2f2f8051a0c0c4d5916b76d6cbb2/numpy-1.26.4-cp311-cp311-win_amd64.whl',
  'bytes': 15811913,
  'sha256': 'cd25bcecc4974d09257ffcd1f098ee778f7834c3ad767fe5db785be9a4aa9cb2',
  'native': [{'bytes': 65024,
              'sha256': 'c31d1abe635e9006caa9fedda260dd4e4fdba31fbdcc8ac0969ab0396a0c6c4e',
              'wheel_member': 'numpy/core/_multiarray_tests.cp311-win_amd64.pyd',
              'installed': 'numpy/core/_multiarray_tests.cp311-win_amd64.pyd'},
             {'bytes': 2836480,
              'sha256': 'c76d812fa5131fe21c8bf9ffbd910f27df80856f910fa61698f23f60cfd9d13e',
              'wheel_member': 'numpy/core/_multiarray_umath.cp311-win_amd64.pyd',
              'installed': 'numpy/core/_multiarray_umath.cp311-win_amd64.pyd'},
             {'bytes': 11264,
              'sha256': '3c9344c097e9894c429f649356f7b5806346e1dc320a33f918b12c0e2dde9d44',
              'wheel_member': 'numpy/core/_operand_flag_tests.cp311-win_amd64.pyd',
              'installed': 'numpy/core/_operand_flag_tests.cp311-win_amd64.pyd'},
             {'bytes': 40448,
              'sha256': 'e6a85ed6a07ac0875ec0c47a526901bef99b08ae8f523e620063ad1e73aa027e',
              'wheel_member': 'numpy/core/_rational_tests.cp311-win_amd64.pyd',
              'installed': 'numpy/core/_rational_tests.cp311-win_amd64.pyd'},
             {'bytes': 2237952,
              'sha256': '0eea703b53158021bdbf9feba1c712c58484abd545b5db37cf398cca5e3a0e58',
              'wheel_member': 'numpy/core/_simd.cp311-win_amd64.pyd',
              'installed': 'numpy/core/_simd.cp311-win_amd64.pyd'},
             {'bytes': 13824,
              'sha256': '59b4b12116102ee06ca72023e51210f43116cc51a6909c2f1402f97cba5a451a',
              'wheel_member': 'numpy/core/_struct_ufunc_tests.cp311-win_amd64.pyd',
              'installed': 'numpy/core/_struct_ufunc_tests.cp311-win_amd64.pyd'},
             {'bytes': 32768,
              'sha256': '0f22ff6f1972c03fc83c1365202b577dee455be5d893a027179c767ab346a666',
              'wheel_member': 'numpy/core/_umath_tests.cp311-win_amd64.pyd',
              'installed': 'numpy/core/_umath_tests.cp311-win_amd64.pyd'},
             {'bytes': 110080,
              'sha256': '207c894d4a97d5eac328a87936b1c5a160cf1163d8b3f59b3c43792d9b5224a4',
              'wheel_member': 'numpy/fft/_pocketfft_internal.cp311-win_amd64.pyd',
              'installed': 'numpy/fft/_pocketfft_internal.cp311-win_amd64.pyd'},
             {'bytes': 17920,
              'sha256': '896b743ebc0f407320ca58877f21275739a74a3a15fc1568bfbe460ebcab08a4',
              'wheel_member': 'numpy/linalg/lapack_lite.cp311-win_amd64.pyd',
              'installed': 'numpy/linalg/lapack_lite.cp311-win_amd64.pyd'},
             {'bytes': 106496,
              'sha256': '05922a2be823ec2e4d2378a73b05bb37f2816aeea86b613a9c80e25764ac8736',
              'wheel_member': 'numpy/linalg/_umath_linalg.cp311-win_amd64.pyd',
              'installed': 'numpy/linalg/_umath_linalg.cp311-win_amd64.pyd'},
             {'bytes': 163840,
              'sha256': '9ad713f6a93c26bb733a90f877b50d51d7f22eef161aa58e40735a5cec149501',
              'wheel_member': 'numpy/random/bit_generator.cp311-win_amd64.pyd',
              'installed': 'numpy/random/bit_generator.cp311-win_amd64.pyd'},
             {'bytes': 596992,
              'sha256': '7dda3c60d25791c53c2eca99eab696347b6a8ee20f3f8307d7efbf086cbbc5bf',
              'wheel_member': 'numpy/random/mtrand.cp311-win_amd64.pyd',
              'installed': 'numpy/random/mtrand.cp311-win_amd64.pyd'},
             {'bytes': 257024,
              'sha256': '05d5fe8a5a79b1d5836e58307afdd0c8570a7c4e1ed0b6a6294f3978db0dc6c4',
              'wheel_member': 'numpy/random/_bounded_integers.cp311-win_amd64.pyd',
              'installed': 'numpy/random/_bounded_integers.cp311-win_amd64.pyd'},
             {'bytes': 175104,
              'sha256': 'f41809c03d13487fa8940cc30f5ff2125143ebf071bca10e081d026028c435fd',
              'wheel_member': 'numpy/random/_common.cp311-win_amd64.pyd',
              'installed': 'numpy/random/_common.cp311-win_amd64.pyd'},
             {'bytes': 695808,
              'sha256': '003c7af2699a370efc1a90bf42ac3b449c27ff9c24b11136dd245bf50ed2240f',
              'wheel_member': 'numpy/random/_generator.cp311-win_amd64.pyd',
              'installed': 'numpy/random/_generator.cp311-win_amd64.pyd'},
             {'bytes': 75264,
              'sha256': '36bbd3767a4efc1e5ddd4f96b7b705fc664e95a629abbe7e3b5e5951cdead3f0',
              'wheel_member': 'numpy/random/_mt19937.cp311-win_amd64.pyd',
              'installed': 'numpy/random/_mt19937.cp311-win_amd64.pyd'},
             {'bytes': 83456,
              'sha256': 'e09a53b33a1908aa4eb58a07166d5beaffe2072ceded2f80df59831adf7fb8df',
              'wheel_member': 'numpy/random/_pcg64.cp311-win_amd64.pyd',
              'installed': 'numpy/random/_pcg64.cp311-win_amd64.pyd'},
             {'bytes': 70144,
              'sha256': '9a777f3f9a59f3d88de84dc3e499138335c3a6cf3bee1b875d9626d6cdf6e098',
              'wheel_member': 'numpy/random/_philox.cp311-win_amd64.pyd',
              'installed': 'numpy/random/_philox.cp311-win_amd64.pyd'},
             {'bytes': 50688,
              'sha256': '180453afefeff645f9fdb2de54a3cb72d8becb87936ea82e2d7a56592aca3068',
              'wheel_member': 'numpy/random/_sfc64.cp311-win_amd64.pyd',
              'installed': 'numpy/random/_sfc64.cp311-win_amd64.pyd'},
             {'bytes': 38168576,
              'sha256': '57b87772bf676b5c2d718c79dddc9f039d79ec3319fee1398cc305adff7b69e5',
              'wheel_member': 'numpy.libs/libopenblas64__v0.3.23-293-gc2f4bdbb-gcc_10_3_0-2bde3a66a51006b2b53eb373ff767a3f.dll',
              'installed': 'numpy.libs/libopenblas64__v0.3.23-293-gc2f4bdbb-gcc_10_3_0-2bde3a66a51006b2b53eb373ff767a3f.dll'}]},
 {'name': 'pydub',
  'version': '0.25.1',
  'filename': 'pydub-0.25.1-py2.py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/a6/53/d78dc063216e62fc55f6b2eebb447f6a4b0a59f55c8406376f76bf959b08/pydub-0.25.1-py2.py3-none-any.whl',
  'bytes': 32327,
  'sha256': '65617e33033874b59d87db603aa1ed450633288aefead953b30bded59cb599a6',
  'native': []},
 {'name': 'platformdirs',
  'version': '4.4.0',
  'filename': 'platformdirs-4.4.0-py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/40/4b/2028861e724d3bd36227adfa20d3fd24c3fc6d52032f4a93c133be5d17ce/platformdirs-4.4.0-py3-none-any.whl',
  'bytes': 18654,
  'sha256': 'abd01743f24e5287cd7a5db3752faf1a2d65353f38ec26d98e25a6db65958c85',
  'native': []},
 {'name': 'requests',
  'version': '2.32.5',
  'filename': 'requests-2.32.5-py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/1e/db/4254e3eabe8020b458f1a747140d32277ec7a271daf1d235b70dc0b4e6e3/requests-2.32.5-py3-none-any.whl',
  'bytes': 64738,
  'sha256': '2462f94637a34fd532264295e186976db0f5d453d1cdd31473c85a6a161affb6',
  'native': []},
 {'name': 'tqdm',
  'version': '4.67.1',
  'filename': 'tqdm-4.67.1-py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/d0/30/dc54f88dd4a2b5dc8a0279bdd7270e735851848b762aeb1c1184ed1f6b14/tqdm-4.67.1-py3-none-any.whl',
  'bytes': 78540,
  'sha256': '26445eca388f82e72884e0d580d5464cd801a3ea01e63e5601bdff9ba6a48de2',
  'native': []},
 {'name': 'certifi',
  'version': '2026.7.22',
  'filename': 'certifi-2026.7.22-py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/0b/a7/71ac2cff56fec219ed242bb11b8efb69fcc4bec75db06fb7bfe35de520e6/certifi-2026.7.22-py3-none-any.whl',
  'bytes': 136983,
  'sha256': '62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775',
  'native': []},
 {'name': 'charset-normalizer',
  'version': '3.4.3',
  'filename': 'charset_normalizer-3.4.3-py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/8a/1f/f041989e93b001bc4e44bb1669ccdcf54d3f00e628229a85b08d330615c5/charset_normalizer-3.4.3-py3-none-any.whl',
  'bytes': 53175,
  'sha256': 'ce571ab16d890d23b5c278547ba694193a45011ff86a9162a71307ed9f86759a',
  'native': []},
 {'name': 'idna',
  'version': '3.10',
  'filename': 'idna-3.10-py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/76/c6/c88e154df9c4e1a2a66ccf0005a88dfb2650c1dffb6f5ce603dfbd452ce3/idna-3.10-py3-none-any.whl',
  'bytes': 70442,
  'sha256': '946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3',
  'native': []},
 {'name': 'urllib3',
  'version': '2.5.0',
  'filename': 'urllib3-2.5.0-py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/a7/c2/fe1e52489ae3122415c51f387e221dd0773709bad6c6cdaa599e8a2c5185/urllib3-2.5.0-py3-none-any.whl',
  'bytes': 129795,
  'sha256': 'e6b01673c0fa6a13e374b50871808eb3bf7046c4b125b216f6bf1cc604cff0dc',
  'native': []},
 {'name': 'colorama',
  'version': '0.4.6',
  'filename': 'colorama-0.4.6-py2.py3-none-any.whl',
  'url': 'https://files.pythonhosted.org/packages/d1/d6/3965ed04c63042e047cb6a3e6ed1a63a35087b6a609aa3a15ed8ac56c221/colorama-0.4.6-py2.py3-none-any.whl',
  'bytes': 25335,
  'sha256': '4f1d9991f5acc0ca119f9d443620b77f9d6b33703e51011c16baf57afb285fc6',
  'native': []}]

ASSETS = [{'name': 'ggml-tiny.en.bin',
  'url': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin',
  'bytes': 77704715,
  'sha256': '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f'},
 {'name': 'jfk.wav',
  'url': 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/a8d002cfd879315632a579e73f0148d06959de36/samples/jfk.wav',
  'bytes': 352078,
  'sha256': '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'},
 {'name': 'model-card.md',
  'url': 'https://huggingface.co/ggerganov/whisper.cpp/raw/5359861c739e955e79d9a303bcbc70fb988958b1/README.md',
  'bytes': 3196,
  'sha256': '21fd967098804f33fc84e803fb0e5ab7666d71801f4027cf28a65e7af09c1758'},
 {'name': 'new-pybind11-LICENSE.txt',
  'url': 'https://raw.githubusercontent.com/pybind/pybind11/b70b8eb332fadf55d7e22b492da0e954c1a4fcb7/LICENSE',
  'bytes': 1684,
  'sha256': '83965b843b98f670d3a85bd041ed4b372c8ec50d7b4a5995a83ac697ba675dcb'},
 {'name': 'new-whisper-cpp-LICENSE.txt',
  'url': 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/f24588a272ae8e23280d9c220536437164e6ed28/LICENSE',
  'bytes': 1078,
  'sha256': '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'},
 {'name': 'old-whisper-cpp-LICENSE.txt',
  'url': 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/0b9af32a8b3fa7e2ae5f15a9a08f5b10394993f5/LICENSE',
  'bytes': 1072,
  'sha256': 'ef78c7e6659e34c798194f0d344e807c722de70cbca1359ef54772661e11ca38'},
 {'name': 'tqdm-LICENCE.txt',
  'url': 'https://raw.githubusercontent.com/tqdm/tqdm/v4.67.1/LICENCE',
  'bytes': 1985,
  'sha256': 'dc33252e829015e3b150086fb9b3a40f6ad6fb32c2f4610ce812fa677d35986a'},
 {'name': 'whisper-model-LICENSE.txt',
  'url': 'https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE',
  'bytes': 1063,
  'sha256': 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d'},
 {'name': 'GPL-3.0.txt',
  'url': 'https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-14.2.0/COPYING3',
  'bytes': 35147,
  'sha256': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'},
 {'name': 'GCC-RUNTIME-EXCEPTION.txt',
  'url': 'https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-14.2.0/COPYING.RUNTIME',
  'bytes': 3324,
  'sha256': '9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74'}]

TARGETS = {
    'macos-arm64': ('aarch64-apple-darwin', '1.5.1', 'macosx_11_0_arm64'),
    'macos-x64': ('x86_64-apple-darwin', '1.2.0', 'macosx_10_9_x86_64'),
    'windows-x64': ('x86_64-pc-windows-msvc', '1.5.1', 'win_amd64'),
    'linux-x64': ('x86_64-unknown-linux-gnu', '1.5.1', 'manylinux'),
}
REFERENCE = 'And so my fellow Americans ask not what your country can do for you ask what you can do for your country'
MAX_WER = 0.10


def receipt(path: Path) -> dict[str, object]:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return {'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')


def checked_download(item: dict[str, object], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with urllib.request.urlopen(str(item['url']), timeout=180) as source, path.open('wb') as dest:
            shutil.copyfileobj(source, dest)
    if receipt(path) != {k: item[k] for k in ('bytes', 'sha256')}:
        raise ValueError(f'Content differs from the committed pin: {path.name}')


def native_member(name: str) -> bool:
    return name.endswith(('.so', '.dylib', '.dll', '.pyd')) or '.so.' in name


def selected_wheels(target: str) -> list[dict[str, object]]:
    _, version, tag = TARGETS[target]
    rows = [r for r in WHEELS if
            (r['name'] != 'pywhispercpp' or r['version'] == version)
            and (str(r['filename']).endswith('none-any.whl') or tag in str(r['filename']))
            and (r['name'] != 'colorama' or target == 'windows-x64')
            and (r['name'] != 'pydub' or target == 'macos-x64')]
    if len({r['name'] for r in rows}) != len(rows):
        raise ValueError('Ambiguous wheel selection')
    return rows


def prepare(args: argparse.Namespace) -> dict[str, object]:
    """Install only committed wheel hashes; never allow a source-build fallback."""
    runtime = args.runtime.resolve(strict=True)
    expected = '3.11.16+20260814-' + TARGETS[args.target][0]
    if (runtime / '.resmon-runtime').read_text().strip() != expected:
        raise ValueError('Staging runtime marker differs from the release pin')
    python = runtime / ('python.exe' if args.target == 'windows-x64' else 'bin/python3')
    payload = runtime.parent / 'voice-probe'
    payload.mkdir(exist_ok=True)
    wheelhouse = args.evidence / 'wheels'
    requirements = []
    manifests = []
    for row in selected_wheels(args.target):
        wheel = wheelhouse / str(row['filename'])
        checked_download(row, wheel)
        requirements.append(f"{row['name']}=={row['version']} --hash=sha256:{row['sha256']}")
        manifest = dict(row, native=[], licenses=[])
        with zipfile.ZipFile(wheel) as archive:
            for name in archive.namelist():
                if name.endswith('/'):
                    continue
                if native_member(name):
                    data = archive.read(name)
                    # Wheel .data/platlib members are relocated to site-packages by pip.
                    installed = re.sub(r'^[^/]+\.data/(?:platlib|purelib)/', '', name)
                    manifest['native'].append({'wheel_member': name, 'installed': installed,
                                               'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
                if any(word in Path(name).name.lower() for word in ('license', 'copying', 'notice', 'licence')):
                    dest = payload / 'licenses' / str(row['filename']) / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(archive.read(name))
                    manifest['licenses'].append({'wheel_member': name, **receipt(dest)})
        if manifest['native'] != row['native']:
            raise ValueError('Wheel native inventory differs from the committed inventory')
        manifests.append(manifest)
    req = args.evidence / 'probe-requirements.txt'
    req.write_text('\n'.join(requirements) + '\n', encoding='utf-8')
    subprocess.run([str(python), '-I', '-m', 'pip', 'freeze', '--all'], check=True,
                   stdout=(args.evidence / 'baseline-pip.txt').open('w'))
    subprocess.run([str(python), '-I', '-m', 'pip', 'install', '--only-binary=:all:',
                    '--no-deps', '--no-index', '--find-links', str(wheelhouse.resolve()),
                    '--require-hashes', '--force-reinstall', '--no-compile',
                    '--report', str((args.evidence / 'pip-install.json').resolve()), '-r', str(req.resolve())], check=True)
    for item in ASSETS:
        checked_download(item, payload / str(item['name']))
    write_json(payload / 'manifest.json', {'target': args.target, 'runtime_pin': expected,
                                          'wheels': manifests, 'assets': ASSETS})
    shutil.copytree(payload / 'licenses', args.evidence / 'licenses', dirs_exist_ok=True)
    shutil.copy2(payload / 'manifest.json', args.evidence / 'manifest.json')
    return {'status': 'pass', 'payload': str(payload), 'wheels': len(manifests)}


def word_error(reference: str, actual: str) -> dict[str, object]:
    """Word-level Levenshtein distance; lower case, ignore punctuation, no stemming."""
    ref = re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", reference.lower())
    hyp = re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", actual.lower())
    previous = list(range(len(hyp) + 1))
    for i, expected in enumerate(ref, 1):
        current = [i]
        for j, observed in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1,
                               previous[j - 1] + (expected != observed)))
        previous = current
    return {'reference_words': len(ref), 'edits': previous[-1],
            'wer': previous[-1] / len(ref), 'threshold': MAX_WER,
            'reference_normalized': ref, 'hypothesis_normalized': hyp}


def deny_network(event: str, arguments: tuple[object, ...]) -> None:
    if event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo'):
        raise RuntimeError('Transcription probe is offline; network access is forbidden')


def transcribe(args: argparse.Namespace) -> dict[str, object]:
    started = time.perf_counter()
    resources = args.resources.resolve(strict=True)
    runtime = (resources / 'backend/python').resolve(strict=True)
    if not sys.flags.isolated or not (resources / 'app.asar').is_file():
        raise ValueError('Need isolated Python and app.asar; a staging directory cannot pass')
    if Path(sys.prefix).resolve() != runtime or Path(sys.base_prefix).resolve() != runtime:
        raise ValueError('This is not the standalone interpreter inside the requested app')
    if not Path(sys.executable).resolve().is_relative_to(runtime):
        raise ValueError('Executable escapes the packaged runtime')
    if sys.version_info[:3] != (3, 11, 16):
        raise ValueError('Wrong interpreter version')
    payload = resources / 'backend/voice-probe'
    manifest = json.loads((payload / 'manifest.json').read_text())
    expected_pin = '3.11.16+20260814-' + TARGETS[args.target][0]
    if manifest['target'] != args.target or manifest['runtime_pin'] != expected_pin:
        raise ValueError('Manifest target/runtime differs from requested target')
    if (runtime / '.resmon-runtime').read_text().strip() != expected_pin:
        raise ValueError('Wrong runtime pin')
    # A manifest shipped beside the binary is not its own authority: match it
    # against this script's pins before comparing installed files with its members.
    if [{k: r[k] for k in ('name', 'version', 'filename', 'url', 'bytes', 'sha256', 'native')}
            for r in manifest['wheels']] != selected_wheels(args.target):
        raise ValueError('Wheel manifest differs from committed wheel pins')
    site = Path(sysconfig.get_paths()['platlib']).resolve()
    if not site.is_relative_to(runtime):
        raise ValueError('site-packages escapes runtime')
    binaries = []
    for row in manifest['wheels']:
        if importlib.metadata.version(row['name']) != row['version']:
            raise ValueError('Installed distribution version differs: ' + row['name'])
        for member in row['native']:
            path = (site / member['installed']).resolve(strict=True)
            observed = receipt(path)
            if not path.is_relative_to(runtime) or observed != {k: member[k] for k in ('bytes', 'sha256')}:
                raise ValueError('Native member differs from inspected wheel: ' + str(path))
            binaries.append({'wheel': row['filename'], 'wheel_sha256': row['sha256'],
                             'wheel_member': member['wheel_member'], 'path': str(path), **observed})
    for item in ASSETS:
        path = (payload / str(item['name'])).resolve(strict=True)
        if not path.is_relative_to(resources) or receipt(path) != {k: item[k] for k in ('bytes', 'sha256')}:
            raise ValueError('Packaged asset differs: ' + str(path))
    sys.addaudithook(deny_network)
    load_start = time.perf_counter()
    import numpy as np
    from pywhispercpp.model import Model
    import _pywhispercpp as native
    for module in (np, sys.modules['pywhispercpp.model'], native):
        if not Path(module.__file__).resolve().is_relative_to(runtime):
            raise ValueError('Imported module escapes packaged runtime')
    # Feed verified PCM directly, avoiding ffmpeg, device capture and any codec download.
    with wave.open(str(payload / 'jfk.wav'), 'rb') as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError('Expected mono 16-bit PCM at 16 kHz')
        frames = wav.getnframes()
        samples = np.frombuffer(wav.readframes(frames), dtype='<i2').astype(np.float32) / 32768.0
    params = dict(n_threads=4, language='en', translate=False, no_context=True,
                  print_progress=False, print_realtime=False, print_timestamps=False,
                  temperature=0.0)
    # 1.2.0 predates the GPU context option; its Intel wheel uses CPU/Accelerate.
    if TARGETS[args.target][1] == '1.5.1':
        params['context_params'] = {'use_gpu': False}
    model = Model(str(payload / 'ggml-tiny.en.bin'), **params)
    loaded = time.perf_counter()
    segments = model.transcribe(samples)
    finished = time.perf_counter()
    actual = ' '.join(segment.text.strip() for segment in segments).strip()
    score = word_error(REFERENCE, actual)
    result = {'status': 'pass' if score['wer'] <= MAX_WER else 'fail',
              'target': args.target, 'runtime_pin': expected_pin, 'python': sys.version,
              'platform': platform.platform(), 'machine': platform.machine(),
              'processor': platform.processor(), 'logical_cpus': os.cpu_count(),
              'resources': str(resources), 'executable': str(Path(sys.executable).resolve()),
              'binding_version': TARGETS[args.target][1], 'native_module': str(native.__file__),
              'native_binaries': binaries, 'fixture_seconds': frames / 16000,
              'reference': REFERENCE, 'transcription': actual, 'accuracy': score,
              'timing_seconds': {'imports_and_model_load': loaded - load_start,
                                 'transcription': finished - loaded, 'total': finished - started},
              'parameters': params, 'network': 'Python socket audit hook denies bind/connect/DNS',
              'scope': 'direct packaged Python invocation; no Electron integration or microphone claim'}
    return result


def negative(args: argparse.Namespace) -> dict[str, object]:
    """Corrupt a COPY of the packaged runtime and require a specific import failure."""
    resources = args.resources.resolve(strict=True)
    runtime = resources / 'backend/python'
    dest = args.evidence / 'broken-runtime'
    if dest.exists():
        raise ValueError('Negative control requires a fresh destination')
    shutil.copytree(runtime, dest, symlinks=True)
    try:
        native = list(dest.rglob('_pywhispercpp*.so')) + list(dest.rglob('_pywhispercpp*.pyd'))
        if len(native) != 1 or native[0].is_symlink():
            raise ValueError('Expected one regular extension in the copied runtime')
        original = runtime / native[0].relative_to(dest)
        before = receipt(original)
        native[0].write_bytes(b'Deliberately invalid native extension for the voice probe.\n')
        python = dest / ('python.exe' if args.target == 'windows-x64' else 'bin/python3')
        child = """import json,sys
try:
 import _pywhispercpp
except ImportError as exc:
 print(json.dumps({'stage':'native_import','exception':type(exc).__name__,'error':str(exc)}))
 sys.exit(1)
print(json.dumps({'stage':'unexpected_success'}))
"""
        process = subprocess.run([str(python), '-I', '-c', child], capture_output=True, text=True, timeout=60)
        args.evidence.mkdir(parents=True, exist_ok=True)
        (args.evidence / 'negative.stdout.txt').write_text(process.stdout, encoding='utf-8')
        (args.evidence / 'negative.stderr.txt').write_text(process.stderr, encoding='utf-8')
        observed = json.loads(process.stdout)
        if (process.returncode != 1 or observed.get('stage') != 'native_import'
                or observed.get('exception') != 'ImportError' or '_pywhispercpp' not in observed.get('error', '')
                or receipt(original) != before):
            raise ValueError('Broken binary did not reach the specific loader failure, or original changed')
        return {'status': 'pass', 'returncode': process.returncode, 'failure': observed,
                'original_unchanged': before, 'broken': receipt(native[0]),
                'scope': 'copy of installer-contained runtime; original installer is untouched'}
    finally:
        shutil.rmtree(dest)


def measure(args: argparse.Namespace) -> dict[str, object]:
    artifacts = [p for p in args.release.iterdir() if p.suffix in ('.dmg', '.AppImage', '.exe')]
    if len(artifacts) != 1:
        raise ValueError('Expected exactly one installer')
    result = {'installer': artifacts[0].name, **receipt(artifacts[0])}
    if args.baseline:
        baseline = json.loads(args.baseline.read_text())
        result['baseline'] = baseline
        result['growth_bytes'] = result['bytes'] - baseline['bytes']
        result['scope'] = 'one paired unsigned build; compression and build nondeterminism included'
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'transcribe', 'negative', 'measure'])
    parser.add_argument('--target', choices=TARGETS, required=True)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--resources', type=Path)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.evidence.mkdir(parents=True, exist_ok=True)
    try:
        result = globals()[args.mode](args)
        code = int(result.get('status', 'pass') != 'pass')
    except Exception as exc:
        result = {'status': 'fail', 'stage': args.mode, 'error': f'{type(exc).__name__}: {exc}'}
        code = 1
    result['exit_code'] = code
    write_json(args.output, result)
    print(json.dumps(result, indent=2))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
