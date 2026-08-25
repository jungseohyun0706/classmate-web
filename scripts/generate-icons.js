// PWA 아이콘 생성 스크립트
// 실행: node scripts/generate-icons.js (레포 루트에서)
// sharp(next의 의존성으로 node_modules에 이미 존재)로 인라인 SVG를 PNG로 렌더링합니다.
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons')
const BRAND = '#2E6E5C'

// 글꼴 의존성을 피하기 위해 "C"를 원호(arc) 패스로 직접 그립니다.
// 중심 (256,256), 반지름 120, 두께 64, 오른쪽이 열린 형태.
const LETTER =
  '<path d="M333.1 164.1 A120 120 0 1 0 333.1 347.9" fill="none" ' +
  'stroke="#FFFFFF" stroke-width="64" stroke-linecap="round"/>'

/**
 * @param {{ maskable: boolean }} options
 * @returns {string} SVG 마크업
 */
function buildSvg({ maskable }) {
  // maskable: 배경은 캔버스 전체를 채우고, 아트는 80%로 축소(총 20% 안전 여백).
  const art = maskable
    ? `<g transform="translate(256 256) scale(0.8) translate(-256 -256)">${LETTER}</g>`
    : LETTER
  const rx = maskable ? 0 : 115
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    `<rect width="512" height="512" rx="${rx}" fill="${BRAND}"/>` +
    art +
    '</svg>'
  )
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const targets = [
    { file: 'icon-192.png', size: 192, maskable: false },
    { file: 'icon-512.png', size: 512, maskable: false },
    { file: 'icon-maskable-512.png', size: 512, maskable: true },
    // iOS는 자체적으로 모서리를 둥글게 처리하므로 풀블리드(maskable) 아트를 사용합니다.
    { file: 'apple-touch-icon.png', size: 180, maskable: true },
  ]

  for (const target of targets) {
    const svg = Buffer.from(buildSvg({ maskable: target.maskable }))
    const outPath = path.join(OUT_DIR, target.file)
    await sharp(svg, { density: 300 })
      .resize(target.size, target.size)
      .png()
      .toFile(outPath)
    const { size } = fs.statSync(outPath)
    console.log(`생성 완료: ${outPath} (${size} bytes)`)
  }
}

main().catch((error) => {
  console.error('아이콘 생성 실패:', error)
  process.exit(1)
})
