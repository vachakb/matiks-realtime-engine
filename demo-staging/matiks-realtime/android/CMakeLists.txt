project(MatiksRealtime)
cmake_minimum_required(VERSION 3.9.0)

set (PACKAGE_NAME MatiksRealtime)
set (CMAKE_VERBOSE_MAKEFILE ON)
set (CMAKE_CXX_STANDARD 20)

# Define C++ library and add all sources.
# - src/main/cpp/cpp-adapter.cpp : JNI_OnLoad → registerAllNatives()
# - ../cpp/HybridMatiksRealtime.cpp : our HybridObject implementation (includes aes.hpp)
add_library(${PACKAGE_NAME} SHARED
        src/main/cpp/cpp-adapter.cpp
        ../cpp/HybridMatiksRealtime.cpp
)

# Add Nitrogen specs :) — generated spec sources + include dirs + the NitroModules link.
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/MatiksRealtime+autolinking.cmake)

# Set up local includes
#   "src/main/cpp" — generated OnLoad header
#   "../cpp"       — HybridMatiksRealtime.hpp + aes.hpp
include_directories(
        "src/main/cpp"
        "../cpp"
)

find_library(LOG_LIB log)

# Link all libraries together
target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android                                   # <-- Android core
)
