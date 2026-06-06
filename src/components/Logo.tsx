// 品牌識別資產：三色填色羽毛（去背版，與桌面 app icon 同源的那張羽毛）。
// 為什麼用 <img> 點陣而非 SVG：母圖的多葉平滑漸層難以向量化（手畫 SVG 還原不了、
// 從 tile 圖去背又會留下圓角方塊鬼影），故直接引用去背 PNG。
// 羽毛固定品牌三色、不隨 --primary 變色。
import featherUrl from "../assets/fledge-feather.png";

// 去背資產長寬比（240×256）；由 size（高）反推寬，避免 layout shift
const FEATHER_RATIO = 240 / 256;

export function FeatherMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src={featherUrl}
      alt=""
      aria-hidden="true"
      width={Math.round(size * FEATHER_RATIO)}
      height={size}
      style={{ display: "block" }}
    />
  );
}
