cmake_minimum_required(VERSION 3.22.1)
project(bare_nativehelper_stub C)

add_library(
  bare_nativehelper_stub
  SHARED
  bare_nativehelper_stub.c
)

set_target_properties(
  bare_nativehelper_stub
  PROPERTIES
    OUTPUT_NAME nativehelper
)
