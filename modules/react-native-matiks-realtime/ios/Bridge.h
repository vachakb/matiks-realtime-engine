// Umbrella / bridge header for the MatiksRealtime pod.
//
// This C++-only Nitro module has no Swift, so there is no Swift<->C++ bridging to do
// here. The file exists so the pod has a stable header entry point; nitrogen's
// generated MatiksRealtime+autolinking.rb wires the actual sources & include paths.
#pragma once
