# The app's native module for macOS (USB serial, Bluetooth LE, recordings folder).
# Kept as a local pod so it builds without editing the Xcode project by hand.
Pod::Spec.new do |s|
  s.name         = 'MedhubNative'
  s.version      = '0.1.0'
  s.summary      = 'Medhub device link and recordings storage for macOS'
  s.homepage     = 'https://github.com/dkaloger/Medhub'
  s.license      = { :type => 'Proprietary' }
  s.author       = 'Medhub'
  s.source       = { :path => '.' }
  s.platforms    = { :osx => '14.0' }
  s.source_files = '*.{h,m,mm}'
  s.frameworks   = 'IOKit', 'CoreBluetooth', 'AppKit'
  s.dependency 'React-Core'
end
