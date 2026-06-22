require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "MatiksRealtime"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/matiks/react-native-matiks-realtime"
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/matiks/react-native-matiks-realtime.git", :tag => "#{s.version}" }

  s.source_files = [
    # Autolinking/Registration (Objective-C++), if any handwritten glue lives here
    "ios/**/*.{m,mm}",
    # Implementation (C++ objects): HybridMatiksRealtime.{hpp,cpp} + aes.hpp
    "cpp/**/*.{hpp,cpp}",
  ]

  # Pulls in the nitrogen-generated spec sources + adds the generated include dirs.
  load 'nitrogen/generated/ios/MatiksRealtime+autolinking.rb'
  add_nitrogen_files(s)

  s.pod_target_xcconfig = {
    # C++20 to match nitrogen's generated code and our std::thread / std::async usage.
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
  }

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
