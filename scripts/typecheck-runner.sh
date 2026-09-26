#!/bin/sh
# Type-checks the on-device XCTest runner against the iOS SDK (no signing,
# no device). Catches Swift errors before a runner install, not on the phone.
set -e
cd "$(dirname "$0")/.."
if ! xcrun --sdk iphoneos --show-sdk-platform-path >/dev/null 2>&1; then
  echo "typecheck-runner: iOS SDK not found (Xcode missing); skipping" >&2
  exit 0
fi
P=$(xcrun --sdk iphoneos --show-sdk-platform-path)
xcrun --sdk iphoneos swiftc -typecheck -suppress-warnings -target arm64-apple-ios17.0 \
  -F "$P/Developer/Library/Frameworks" -I "$P/Developer/usr/lib" \
  ios/HeissRunner/UITests/*.swift
echo "typecheck-runner: ok"
