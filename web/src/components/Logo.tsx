/**
 * The Talos logo, from the brand SVG files. The navy parts follow
 * currentColor so the same logo works on the navy sidebar (white) and on
 * light pages (navy). The emerald core never changes.
 */

const WORD =
  'M5.10 188.50L176.10 188.50L176.10 235.30L119.70 235.30L119.70 400L60.90 400L60.90 235.30L5.10 235.30L5.10 188.50M335.70 400L324.30 365.50L249.30 365.50L237.90 400L176.10 400L253.20 188.50L321 188.50L397.80 400L335.70 400M264.30 320.50L309.60 320.50L286.80 252.10L264.30 320.50M468.30 188.50L468.30 355L534 355L534 400L409.50 400L409.50 188.50L468.30 188.50M857.70 402.10Q820.80 402.10 797.10 384.55Q773.40 367 771.60 334.30L834.30 334.30Q835.20 345.40 840.90 350.50Q846.60 355.60 855.60 355.60Q863.70 355.60 868.950 351.55Q874.20 347.50 874.20 340.30Q874.20 331 865.50 325.90Q856.80 320.80 837.30 314.50Q816.60 307.60 803.85 301.15Q791.10 294.70 781.65 282.25Q772.20 269.80 772.20 249.70Q772.20 229.30 782.40 214.75Q792.60 200.20 810.60 192.70Q828.60 185.20 851.40 185.20Q888.30 185.20 910.35 202.45Q932.40 219.70 933.90 250.90L870 250.90Q869.70 241.30 864.15 236.50Q858.60 231.70 849.90 231.70Q843.30 231.70 839.10 235.60Q834.90 239.50 834.90 246.70Q834.90 252.70 839.55 257.05Q844.20 261.40 851.10 264.55Q858 267.70 871.50 272.50Q891.60 279.40 904.65 286.15Q917.70 292.90 927.15 305.05Q936.60 317.20 936.60 335.80Q936.60 354.70 927.15 369.70Q917.70 384.70 899.85 393.40Q882 402.10 857.70 402.10';

function MarkShapes() {
  return (
    <>
      <circle cx="650.5" cy="293.5" r="100" fill="none" stroke="currentColor" strokeWidth="18.95" />
      <circle cx="650.5" cy="193.5" r="16.84" fill="currentColor" />
      <circle cx="564.2" cy="343.5" r="16.84" fill="currentColor" />
      <circle cx="736.8" cy="343.5" r="16.84" fill="currentColor" />
      <circle cx="650.5" cy="293.5" r="25.79" fill="#0E9F6E" />
    </>
  );
}

export function LogoWordmark({ height = 22, title = 'Talos' }: { height?: number; title?: string }) {
  return (
    <svg viewBox="-15.90 164.20 973.50 258.90" height={height} role="img" aria-label={title} className="logo-word">
      <path d={WORD} fill="currentColor" />
      <MarkShapes />
    </svg>
  );
}

export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg viewBox="530.5 173.5 240 240" width={size} height={size} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <MarkShapes />
    </svg>
  );
}
