const assert = require('assert');
const {
  decodeCommandOutput,
  parseWindowsWlanInterfaces,
  parseNmcliActiveWifi,
  normalizeSsid,
  normalizeBssid,
  parseLocationConsent,
  ipv4InCidr,
} = require('./wifiProbe.cjs');

function expectNet(text, ssid, bssid) {
  const parsed = parseWindowsWlanInterfaces(text);
  assert.strictEqual(parsed.ssid, ssid, text.slice(0, 40));
  assert.strictEqual(parsed.bssid, bssid);
  return parsed;
}

const english = `
Name                   : Wi-Fi
Description            : Intel(R) Wi-Fi 6 AX201
GUID                   : 12345678-1234-1234-1234-1234567890ab
Physical address       : 00:11:22:33:44:55
State                  : connected
SSID                   : Office WiFi
BSSID                  : AA-BB-CC-DD-EE-FF
Network type           : Infrastructure
Signal                 : 90%
Profile                : Office WiFi

Name                   : Wi-Fi 2
State                  : disconnected
SSID                   : Cafe
BSSID                  : 11:22:33:44:55:66
`;
expectNet(english, 'Office WiFi', 'aa:bb:cc:dd:ee:ff');

const french = `
Nom                    : Wi-Fi
Description            : Intel
GUID                   : 12345678-1234-1234-1234-1234567890ab
Adresse physique       : 00-11-22-33-44-55
État                   : connecté
SSID                   : Bureau Paris
BSSID                  : AA:BB:CC:DD:EE:10
Type de réseau         : Infrastructure
Signal                 : 80%
Profil                 : Bureau Paris
`;
expectNet(french, 'Bureau Paris', 'aa:bb:cc:dd:ee:10');

const german = `
Name                   : WLAN
Beschreibung           : Intel
GUID                   : 12345678-1234-1234-1234-1234567890ab
Physische Adresse      : 10:20:30:40:50:60
Status                 : Verbunden
SSID                   : "Büro   Netz"
BSSID                  : AA-BB-CC-DD-EE-11
Signal                 : 70%
Profil                 : Büro Netz
`;
const de = expectNet(german, 'Büro Netz', 'aa:bb:cc:dd:ee:11');
assert.strictEqual(de.usedProfile, false);

const urdu = `
نام                    : Wi-Fi
تفصیل                  : Intel
GUID                   : 12345678-1234-1234-1234-1234567890ab
جسمانی پتہ             : 00:11:22:33:44:55
حالت                   : منسلک
SSID                   : دفتر مرکزی
BSSID                  : aa-bb-cc-dd-ee-22
سگنل                   : 60%
پروفائل                : دفتر مرکزی
`;
expectNet(urdu, 'دفتر مرکزی', 'aa:bb:cc:dd:ee:22');

const arabicBlank = `
الاسم                  : Wi-Fi
الوصف                  : Intel
GUID                   : 12345678-1234-1234-1234-1234567890ab
العنوان                : 00:11:22:33:44:55
الحالة                 : متصل
SSID                   : 
BSSID                  : AA-BB-CC-DD-EE-33
الإشارة                : 55%
ملف التعريف            : مكتب الرياض
`;
const ar = expectNet(arabicBlank, 'مكتب الرياض', 'aa:bb:cc:dd:ee:33');
assert.strictEqual(ar.ssidBlank, true);
assert.strictEqual(ar.usedProfile, true);

const quoted = `
State                  : connected
SSID                   : "  Office   WiFi  "
BSSID                  : AA-BB-CC-DD-EE-FF
Profile                : Office WiFi
`;
expectNet(quoted, 'Office WiFi', 'aa:bb:cc:dd:ee:ff');

const hidden = `
State                  : connected
SSID                   : 
BSSID                  : 10:20:30:40:50:60
Profile                : Hidden Office
`;
const hid = expectNet(hidden, 'Hidden Office', '10:20:30:40:50:60');
assert.strictEqual(hid.ssidBlank, true);

const nonAscii = `
State                  : connected
SSID                   : مكتب-Üni
BSSID                  : ab-cd-ef-01-23-45
Profile                : مكتب-Üni
`;
expectNet(nonAscii, 'مكتب-Üni', 'ab:cd:ef:01:23:45');

const positionalArabic = `
الاسم                  : Wi-Fi
الوصف                  : Intel
المعرف                 : 12345678-1234-1234-1234-1234567890ab
العنوان                : 11:22:33:44:55:66
الحالة                 : متصل
الشبكة                 : شبكة المكتب
النقطة                 : AA-BB-CC-DD-EE-44
الملف                  : شبكة المكتب
`;
expectNet(positionalArabic, 'شبكة المكتب', 'aa:bb:cc:dd:ee:44');

const utf16 = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('State : connected\r\nSSID : Branch-A\r\nBSSID : aa:bb:cc:dd:ee:01\r\nProfile : Branch-A\r\n', 'utf16le'),
]);
const from16 = parseWindowsWlanInterfaces(decodeCommandOutput(utf16));
assert.strictEqual(from16.ssid, 'Branch-A');
assert.strictEqual(from16.bssid, 'aa:bb:cc:dd:ee:01');

const utf16NoBom = Buffer.from('State : connected\r\nSSID : Branch-B\r\nBSSID : aa:bb:cc:dd:ee:02\r\n', 'utf16le');
const from16b = parseWindowsWlanInterfaces(decodeCommandOutput(utf16NoBom));
assert.strictEqual(from16b.ssid, 'Branch-B');

// OEM code page 850: "Café" is 43 61 66 82
const oem = Buffer.concat([
  Buffer.from('State : connected\r\nSSID : ', 'latin1'),
  Buffer.from([0x43, 0x61, 0x66, 0x82]),
  Buffer.from('\r\nBSSID : aa:bb:cc:dd:ee:03\r\nProfile : Cafe\r\n', 'latin1'),
]);
const fromOem = parseWindowsWlanInterfaces(decodeCommandOutput(oem));
assert.strictEqual(fromOem.ssid, 'Café');
assert.strictEqual(fromOem.bssid, 'aa:bb:cc:dd:ee:03');

const nm = parseNmcliActiveWifi('no:Other:11\\:22\\:33\\:44\\:55\\:66\nyes:Office\\:WiFi:aa\\:bb\\:cc\\:dd\\:ee\\:ff\n');
assert.strictEqual(nm.ssid, 'Office:WiFi');
assert.strictEqual(nm.bssid, 'aa:bb:cc:dd:ee:ff');

assert.strictEqual(normalizeSsid('  "Office   WiFi"  '), 'Office WiFi');
assert.strictEqual(normalizeBssid('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
assert.strictEqual(parseLocationConsent('    Value    REG_SZ    Deny\r\n'), false);
assert.strictEqual(parseLocationConsent('    Value    REG_SZ    Allow\r\n'), true);
assert.strictEqual(ipv4InCidr('203.0.113.10', '203.0.113.0/24'), true);
assert.strictEqual(ipv4InCidr('198.51.100.1', '203.0.113.0/24'), false);

console.log('wifiProbe tests ok');
