#include "HybridMatiksRealtime.hpp"

#include "aes.hpp" // PROVEN AES-256 core + fromHex (verbatim from matiks_decrypt.cpp)

#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace margelo::nitro::matiksrealtime {

namespace {

// Run the FIPS-197 known-answer test exactly once per process. If the vendored AES
// miscompiled on this toolchain we fail loudly instead of returning garbage plaintext.
void ensureAesSelfTest() {
  static std::once_flag once;
  static bool ok = false;
  std::call_once(once, [] { ok = aesSelfTest(); });
  if (!ok) {
    throw std::runtime_error(
        "MatiksRealtime: AES-256 FIPS-197 self-test FAILED on this build — refusing to decrypt");
  }
}

// Decrypt one "ivHex:ctHex" blob with the already-expanded key schedule.
// Throws std::runtime_error on any malformed input so the Promise rejects.
std::string decryptOne(const std::string& blob, const aes::Ctx& ctx) {
  const auto colon = blob.find(':');
  if (colon == std::string::npos) {
    throw std::runtime_error("MatiksRealtime: blob missing ':' separator");
  }
  const std::string ivHex = blob.substr(0, colon);
  const std::string ctHex = blob.substr(colon + 1);

  std::vector<uint8_t> iv;
  std::vector<uint8_t> ct;
  if (!fromHex(ivHex, iv) || iv.size() != 16) {
    throw std::runtime_error("MatiksRealtime: bad IV hex (must be 16 bytes)");
  }
  if (!fromHex(ctHex, ct)) {
    throw std::runtime_error("MatiksRealtime: bad ciphertext hex");
  }

  // cbcDecrypt rejects empty / non-16-aligned ciphertext (returns 0) — no OOB read.
  const size_t plen = aes::cbcDecrypt(ctx, iv.data(), ct.data(), ct.size());
  if (plen == 0 && !ct.empty()) {
    throw std::runtime_error("MatiksRealtime: ciphertext not a multiple of 16 bytes");
  }
  return std::string(reinterpret_cast<const char*>(ct.data()), plen);
}

} // namespace

std::shared_ptr<Promise<std::vector<std::string>>>
HybridMatiksRealtime::decryptQuestions(
    const std::vector<std::string>& blobs,
    const std::string& keyUtf8) {
  // The UTF-8 bytes of keyUtf8 ARE the AES-256 key — must be exactly 32 bytes.
  if (keyUtf8.size() != 32) {
    throw std::runtime_error(
        "MatiksRealtime: keyUtf8 must be exactly 32 bytes (UTF-8) for AES-256");
  }

  // Create a pending Promise now; resolve/reject it from the worker thread.
  // Nitro marshals the resolution back onto the JS thread via the CallInvoker.
  auto promise = Promise<std::vector<std::string>>::create();

  // Copy everything the worker needs (the args are references owned by the caller).
  // The Promise (shared_ptr) is captured by value so it stays alive on the worker.
  std::thread([promise, blobs, keyUtf8]() {
    try {
      ensureAesSelfTest();

      // Expand the key schedule ONCE — the same key decrypts every blob.
      aes::Ctx ctx;
      aes::expand(ctx, reinterpret_cast<const uint8_t*>(keyUtf8.data()));

      std::vector<std::string> out;
      out.reserve(blobs.size());
      for (const auto& blob : blobs) {
        out.push_back(decryptOne(blob, ctx));
      }

      // Resolve on the JS thread (Nitro hops via the CallInvoker internally).
      promise->resolve(std::move(out));
    } catch (...) {
      promise->reject(std::current_exception());
    }
  }).detach();

  return promise;

  // ── Idiomatic alternative ──────────────────────────────────────────────
  // Nitro ships `Promise<T>::async(fn)`, which runs `fn` on Nitro's own thread
  // pool and auto-resolves/rejects. Equivalent and shorter:
  //
  //   return Promise<std::vector<std::string>>::async(
  //       [blobs, keyUtf8]() -> std::vector<std::string> {
  //         ensureAesSelfTest();
  //         aes::Ctx ctx;
  //         aes::expand(ctx, reinterpret_cast<const uint8_t*>(keyUtf8.data()));
  //         std::vector<std::string> out; out.reserve(blobs.size());
  //         for (const auto& b : blobs) out.push_back(decryptOne(b, ctx));
  //         return out;
  //       });
  //
  // The explicit std::thread above is used to match the requested pattern
  // (12-native-infrastructure.md §3: background std::thread + CallInvoker) and to
  // keep one dedicated thread per match-start decrypt rather than sharing the pool.
}

} // namespace margelo::nitro::matiksrealtime
