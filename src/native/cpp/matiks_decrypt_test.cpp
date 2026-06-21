// Test suite for the MatiksRealtime native decrypt core.
// L1 (correctness/robustness/thread-safety/fuzz): runs by default, on macOS AND the A13.
// L3 (golden, real captured data): runs only if you pass the key + sample path as args, so
//     no key/data is committed:  ./mtest "<32-char-key>" <enc_questions.json>
//
// Build: clang++ -O2 -std=c++17 -pthread matiks_decrypt_test.cpp -o mtest
#define MATIKS_TEST_BUILD
#include "matiks_decrypt.cpp"
#include <fstream>
#include <thread>
#include <random>

static int passed = 0, failed = 0;
static void check(bool c, const char* name){ if(c) passed++; else { failed++; printf("  FAIL: %s\n", name); } }
static std::vector<uint8_t> pkcs7(const std::string& s){ std::vector<uint8_t> b(s.begin(), s.end()); size_t pad = 16-(b.size()%16); for(size_t i=0;i<pad;i++) b.push_back((uint8_t)pad); return b; }

// ── Level 3: golden test against REAL captured questions (key + path via argv) ──
static void golden(const char* keyStr, const char* path){
  std::ifstream f(path);
  if(!f){ printf("  L3 golden: cannot open %s\n", path); failed++; return; }
  std::string raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  if(strlen(keyStr)!=32){ printf("  L3 golden: key must be 32 chars (AES-256)\n"); failed++; return; }
  aes::Ctx ctx; aes::expand(ctx,(const uint8_t*)keyStr);  // CryptoJS Utf8.parse(key) = ASCII bytes
  auto isHex=[](char c){ return (c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F'); };
  int total=0, ok=0; size_t i=0, n=raw.size();
  while(i<n){
    if(!isHex(raw[i])){ i++; continue; }
    size_t a=i; while(i<n && isHex(raw[i])) i++;
    if(i<n && raw[i]==':'){
      size_t colon=i; i++; size_t b=i; while(i<n && isHex(raw[i])) i++;
      std::string ivH=raw.substr(a,colon-a), ctH=raw.substr(b,i-b);
      if(ivH.size()==32 && ctH.size()>=32 && (ctH.size()%32)==0){       // 16-byte IV : 16-byte-aligned CT
        std::vector<uint8_t> iv, ct;
        if(fromHex(ivH,iv) && fromHex(ctH,ct) && iv.size()==16){
          total++;
          size_t pl=aes::cbcDecrypt(ctx, iv.data(), ct.data(), ct.size());
          size_t printable=0; for(size_t k=0;k<pl;k++){ unsigned char ch=ct[k]; if(ch>=0x09 && ch<0x7f) printable++; }
          if(pl>0 && printable*100/pl >= 95) ok++;   // ≥95% printable ASCII ⇒ a real plaintext, not garbage
        }
      }
    }
  }
  printf("  L3 golden (REAL captured data): %d/%d blobs decrypted to valid printable JSON\n", ok, total);
  check(total>0 && ok==total, "L3 golden: all real captured questions decrypt correctly");
}

int main(int argc, char** argv){
  printf("=== MatiksRealtime native module — test suite ===\n");
  uint8_t key[32]; for(int i=0;i<32;i++) key[i]=(uint8_t)(i*5+3);
  aes::Ctx ctx; aes::expand(ctx,key);

  check(selfTest(), "L1 AES-256 FIPS-197 known-answer test");

  { std::mt19937 rng(7); bool ok=true;
    for(size_t nn : {(size_t)1,(size_t)15,(size_t)16,(size_t)17,(size_t)100,(size_t)1000,(size_t)5000}){
      std::string pt; for(size_t k=0;k<nn;k++) pt+=(char)('A'+(k%26));
      auto buf=pkcs7(pt); uint8_t iv[16]; for(int k=0;k<16;k++) iv[k]=(uint8_t)rng();
      auto enc=buf; aes::cbcEncrypt(ctx,iv,enc.data(),enc.size());
      auto dec=enc; size_t pl=aes::cbcDecrypt(ctx,iv,dec.data(),dec.size());
      if(!(pl==pt.size() && memcmp(dec.data(),pt.data(),pl)==0)) ok=false;
    }
    check(ok,"L1 encrypt->decrypt round-trip (sizes 1..5000, PKCS7)"); }

  { uint8_t iv[16]={0}; check(aes::cbcDecrypt(ctx,iv,nullptr,0)==0,"L1 empty ciphertext handled"); }
  { std::vector<uint8_t> o; check(!fromHex("abc",o) && !fromHex("zz",o) && fromHex("00ff",o),"L1 malformed hex rejected"); }
  { std::vector<uint8_t> bad(20,0xAB); uint8_t iv[16]={0}; check(aes::cbcDecrypt(ctx,iv,bad.data(),bad.size())==0,"L1 non-16-aligned ciphertext rejected (no OOB)"); }
  { std::string pt="hello world test!!"; auto buf=pkcs7(pt); uint8_t iv[16]={1}; auto enc=buf; aes::cbcEncrypt(ctx,iv,enc.data(),enc.size());
    uint8_t k2[32]; for(int i=0;i<32;i++) k2[i]=(uint8_t)(i+99); aes::Ctx c2; aes::expand(c2,k2);
    auto dec=enc; size_t pl=aes::cbcDecrypt(c2,iv,dec.data(),dec.size()); check(pl<=dec.size(),"L1 wrong key: graceful (no crash)"); }
  { std::string pt="concurrent decrypt payload xyz"; auto buf=pkcs7(pt); uint8_t iv[16]={2}; auto enc=buf; aes::cbcEncrypt(ctx,iv,enc.data(),enc.size());
    std::atomic<int> ok{0}; std::vector<std::thread> ts;
    for(int t=0;t<8;t++) ts.emplace_back([&]{ for(int r=0;r<200;r++){ auto d=enc; size_t pl=aes::cbcDecrypt(ctx,iv,d.data(),d.size()); if(pl==pt.size()&&memcmp(d.data(),pt.data(),pl)==0) ok++; } });
    for(auto&t:ts) t.join(); check(ok==8*200,"L1 8 threads x200 concurrent decrypts correct (thread-safe)"); }
  { std::mt19937 fr(123); for(int i=0;i<20000;i++){ size_t nn=(fr()%33)*16; std::vector<uint8_t> b(nn); for(auto&x:b) x=(uint8_t)fr(); uint8_t iv[16]; for(int j=0;j<16;j++) iv[j]=(uint8_t)fr(); aes::cbcDecrypt(ctx,iv,b.data(),b.size());
      std::string h; size_t hn=fr()%20; for(size_t j=0;j<hn;j++) h+=(char)(fr()%256); std::vector<uint8_t> o; fromHex(h,o); }
    check(true,"L1 20k fuzz iterations (random blobs + hex) — no crash"); }

  if(argc>=3) golden(argv[1], argv[2]);
  else printf("  (L3 golden skipped — pass <keyString> <enc_questions.json> to run it on real data)\n");

  printf("\n%d passed, %d failed\n", passed, failed);
  return failed ? 1 : 0;
}
