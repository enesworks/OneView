export type Cred = [string, string];

export const BASE_CREDS: Cred[] = [
  ['', ''],
  ['admin', ''],
  ['admin', 'admin'],
  ['admin', '1234'],
  ['admin', '12345'],
  ['admin', '123456'],
  ['admin', '1234567'],
  ['admin', '12345678'],
  ['admin', '123456789'],
  ['admin', 'password'],
  ['admin', 'pass'],
  ['admin', 'password1'],
  ['admin', 'admin123'],
  ['admin', 'Admin123'],
  ['admin', 'Admin1234'],
  ['admin', 'Admin12345'],
  ['admin', 'abc123'],
  ['admin', 'qwerty'],
  ['admin', '123qwe'],
  ['admin', '111111'],
  ['admin', '222222'],
  ['admin', '333333'],
  ['admin', '444444'],
  ['admin', '555555'],
  ['admin', '666666'],
  ['admin', '777777'],
  ['admin', '888888'],
  ['admin', '999999'],
  ['admin', '000000'],
  ['admin', '88888888'],
  ['admin', 'system'],
  ['admin', 'manager'],
  ['admin', 'service'],
  ['admin', 'root'],
  ['admin', 'supervisor'],
  ['admin', 'default'],
  ['admin', 'camera'],
  ['admin', 'cam'],
  ['admin', 'ipcam'],
  ['admin', '1234567890'],
  ['admin', '1'],
  ['admin', '12'],
  ['admin', '123'],
  ['admin', '12345'],
  ['admin', 'admin1'],
  ['admin', 'abcd1234'],
  ['admin', 'P@ssw0rd'],
  ['root', ''],
  ['root', 'root'],
  ['root', 'toor'],
  ['root', 'pass'],
  ['root', 'password'],
  ['root', 'admin'],
  ['root', '1234'],
  ['root', '12345'],
  ['root', '123456'],
  ['root', '54321'],
  ['root', 'root123'],
  ['root', 'vizxv'],
  ['root', 'xc3511'],
  ['root', 'xmhdipc'],
  ['root', 'jvbzd'],
  ['root', 'hi3518'],
  ['root', 'hi3515'],
  ['root', 'klv123'],
  ['root', 'klv1234'],
  ['root', 'Zte521'],
  ['root', 'Ms1234'],
  ['root', 'ipcam_rt5350'],
  ['root', '888888'],
  ['root', '1111111'],
  ['root', 'system'],
  ['root', 'default'],
  ['root', 'cat1029'],
  ['root', 'juantech'],
  ['user', ''],
  ['user', 'user'],
  ['user', 'pass'],
  ['user', '1234'],
  ['user', 'password'],
  ['guest', ''],
  ['guest', 'guest'],
  ['guest', '12345'],
  ['service', 'service'],
  ['supervisor', 'supervisor'],
  ['system', 'system'],
  ['default', 'default'],
  ['support', 'support'],
  ['operator', 'operator'],
  ['manager', 'manager'],
  ['administrator', 'administrator'],
  ['666666', '666666'],
  ['888888', '888888'],
  ['111111', '111111'],
  ['ubnt', 'ubnt'],
  ['tech', 'tech'],
  ['test', 'test'],
  ['admin', '3'],
  ['admin', 'passw0rd'],
  ['admin', 'admin1234'],
  ['admin', 'Admin@123'],
  ['admin', 'letmein'],
  ['admin', 'welcome'],
];

export const VENDOR_CREDS: Record<string, Cred[]> = {
  hikvision: [
    ['admin', '12345'],
    ['admin', 'Admin12345'],
    ['admin', 'hik12345'],
    ['admin', 'hik12345+'],
    ['admin', 'abcd1234'],
    ['admin', 'hik123456'],
    ['admin', 'Hik12345'],
  ],
  dahua: [
    ['admin', 'admin'],
    ['888888', '888888'],
    ['666666', '666666'],
    ['admin', '123456'],
    ['admin', 'password'],
    ['admin', 'admin12345'],
  ],
  axis: [
    ['root', 'pass'],
    ['root', 'admin'],
    ['root', '1234'],
    ['admin', ''],
  ],
  foscam: [
    ['admin', ''],
    ['admin', '1234'],
    ['admin', '123456'],
    ['admin', 'foscam'],
    ['admin', 'password'],
  ],
  reolink: [
    ['admin', ''],
    ['admin', '123456'],
    ['admin', 'reolink'],
    ['admin', 'password'],
  ],
  uniview: [
    ['admin', '123456'],
    ['admin', 'admin'],
    ['admin', '111111'],
    ['admin', '12345678'],
  ],
  tplink: [
    ['admin', 'admin'],
    ['admin', '1234'],
    ['admin', 'password'],
    ['admin', ''],
  ],
  dlink: [
    ['admin', ''],
    ['admin', 'admin'],
    ['admin', '1234'],
    ['admin', 'password'],
    ['root', ''],
  ],
  vivotek: [
    ['root', ''],
    ['root', 'root'],
    ['admin', ''],
    ['admin', '1234'],
  ],
  amcrest: [
    ['admin', 'admin'],
    ['admin', '123456'],
    ['admin', 'amcrest'],
  ],
  geovision: [
    ['admin', 'admin'],
    ['admin', ''],
    ['admin', '1234'],
  ],
  panasonic: [
    ['admin', '12345'],
    ['admin', ''],
    ['admin', '1234'],
  ],
  samsung: [
    ['admin', '4321'],
    ['admin', ''],
    ['admin', '1234567890'],
  ],
  acti: [
    ['admin', '123456'],
    ['admin', ''],
    ['admin', '1234'],
  ],
  brickcom: [
    ['admin', ''],
    ['admin', 'admin'],
    ['admin', 'password'],
  ],
  zosi: [
    ['admin', ''],
    ['admin', '123456'],
  ],
  annke: [
    ['admin', ''],
    ['admin', '123456'],
  ],
  swann: [
    ['admin', ''],
    ['admin', '123456'],
  ],
};

const VENDOR_HINTS: Array<[RegExp, string]> = [
  [/hikvision|hik-?os|dvrdvs|dnvrs|app-webs/i, 'hikvision'],
  [/dahua|dvr|gen-?s?i?|webs|amcrest/i, 'dahua'],
  [/axis|apache.*axis/i, 'axis'],
  [/foscam|ipcam|fc-?cam/i, 'foscam'],
  [/reolink/i, 'reolink'],
  [/uniview|unv|server: *netpos/i, 'uniview'],
  [/tp-?link|tplink/i, 'tplink'],
  [/d-?link|dlink/i, 'dlink'],
  [/vivotek/i, 'vivotek'],
  [/geovision|gv-/i, 'geovision'],
  [/panasonic|wj-|wp-?series/i, 'panasonic'],
  [/samsung|snp-|snd-/i, 'samsung'],
  [/acti/i, 'acti'],
  [/brickcom/i, 'brickcom'],
  [/zosi/i, 'zosi'],
  [/annke/i, 'annke'],
  [/swann/i, 'swann'],
];

export function detectVendor(...hints: Array<string | undefined>): string | null {
  const hay = hints.filter(Boolean).join(' ');
  if (!hay) return null;
  for (const [re, vendor] of VENDOR_HINTS) {
    if (re.test(hay)) return vendor;
  }
  return null;
}

export function credsForVendor(vendor: string | null): Cred[] {
  const seen = new Set<string>();
  const out: Cred[] = [];
  const push = (c: Cred) => {
    const key = `${c[0]}\u0000${c[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  if (vendor && VENDOR_CREDS[vendor]) {
    for (const c of VENDOR_CREDS[vendor]) push(c);
  }
  for (const c of BASE_CREDS) push(c);
  return out;
}
