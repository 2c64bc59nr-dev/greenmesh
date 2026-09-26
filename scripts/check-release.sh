#!/bin/bash
# Release hygiene check: run before every push.
#
# Written after a test script containing a real LAN address was committed by
# accident. Patterns only - this file must never itself contain a real address,
# a device serial or a path from anyone's machine.
set -o pipefail
fail=0

echo "1. secrets"
if git grep -InE "sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY" -- . 2>/dev/null; then
  echo "   ^ a literal secret is present"; fail=1
else
  echo "   ok - none"
fi

echo "2. signing material"
if git ls-files | grep -iE "\.keystore$|\.jks$|keystore\.properties$"; then
  echo "   ^ signing material is tracked"; fail=1
else
  echo "   ok - no keystores tracked"
fi

echo "3. device addresses and adb ports"
hits=$(git grep -InE "192\.168\.[0-9]+\.[0-9]+|:5555" -- . ':(exclude)scripts/check-release.sh' 2>/dev/null | grep -vE "192\.168\.1\.(42|10)\b" || true)
if [ -n "$hits" ]; then
  echo "$hits" | head -5
  echo "   ^ a machine-specific address is present (the .42/.10 UI placeholders are allowed)"; fail=1
else
  echo "   ok - only documentation placeholders"
fi

echo "4. personal paths and device serials"
hits=$(git grep -InE "C:\\?Users\\?[A-Za-z]+|[A-Z0-9]{15,}" -- "*.sh" "*.md" "*.js" "*.json" 2>/dev/null | grep -vE "package-lock|integrity|sha512|node_modules" || true)
if [ -n "$hits" ]; then echo "$hits" | head -5; echo "   ^ check this: personal path or long identifier"; fail=1
else echo "   ok - none"; fi

echo "5. build outputs and models must not be tracked"
if git ls-files | grep -iE "\.apk$|\.aab$|\.gguf$|\.onnx$|\.bin$|^android/app/build/"; then
  echo "   ^ build output or model is tracked"; fail=1
else
  echo "   ok - none (the APK ships as a GitHub release asset)"
fi

echo
if [ $fail -eq 0 ]; then echo "RESULT: clean, safe to publish"; else echo "RESULT: FIX THE ABOVE BEFORE PUSHING"; fi
exit $fail
