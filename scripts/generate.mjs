// Generates the profile README and its animated SVG panels from
// data/profile.json + live GitHub data (GraphQL API).
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/generate.mjs
//
// Runs daily in .github/workflows/profile.yml.
import { readFile, writeFile } from 'node:fs/promises'
import { layout } from './pixelfont.mjs'

const ROOT = new URL('..', import.meta.url)
const profile = JSON.parse(await readFile(new URL('data/profile.json', ROOT), 'utf8'))
const token = process.env.GITHUB_TOKEN
if (!token) throw new Error('GITHUB_TOKEN is required')

const W = 880
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
const C = { bg: '#0a0a0a', line: '#222', dim: '#5e5e5e', mid: '#8e8e8e', text: '#b4b4b4', hi: '#f2f2f2' }
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
// GitHub's dark contribution scale
const LEVELS = ['#1c2128', '#0e4429', '#006d32', '#26a641', '#39d353']
// GitHub linguist colors (C is lightened so it shows on black)
const COLORS = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', CSS: '#663399', HTML: '#e34c26', C: '#a8b9cc', Python: '#3572a5',
  Go: '#00add8', Java: '#b07219', PostgreSQL: '#336791', React: '#61dafb', 'React Native': '#61dafb', Vite: '#646cff',
  Docker: '#2496ed', Linux: '#fcc624', Git: '#f05032', n8n: '#ea4b71', 'APIs REST': '#8e8e8e', 'Agentes de IA': '#d97757',
}

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const r2 = (n) => Math.round(n * 100) / 100

// Deterministic randomness so regenerating without new data yields identical files.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fill and size go in attributes, not CSS, so per-text values always win over the defaults.
const CLASS_FILL = { cap: C.dim, lbl: C.hi }
function t(x, y, s, attrs = '') {
  const cls = attrs.match(/class="(\w+)"/)?.[1]
  if (!attrs.includes('fill=') && CLASS_FILL[cls]) attrs += ` fill="${CLASS_FILL[cls]}"`
  return `<text x="${r2(x)}" y="${r2(y)}" ${attrs}>${esc(s)}</text>`
}

/** Pixel-font text as rects that flicker in left to right. */
function pixelText(text, x0, y0, size, { delay = 0, spread = 0.8, fill = C.hi, rand }) {
  const { pixels, width } = layout(text)
  const rects = pixels.map(({ x, y }) => {
    const d = delay + (x / Math.max(width, 1)) * spread + rand() * 0.25
    return `<rect class="px" x="${x0 + x * size}" y="${y0 + y * size}" width="${size - 1}" height="${size - 1}" style="animation-delay:${d.toFixed(2)}s"/>`
  })
  return { svg: `<g fill="${fill}">${rects.join('')}</g>`, width: width * size }
}

function label(x, y, text, delay = 0) {
  return `<g class="fade" style="animation-delay:${delay}s"><rect x="${x}" y="${y - 8}" width="7" height="7" fill="${C.hi}"/>${t(x + 15, y, text, `class="lbl"`)}</g>`
}

function svg(w, h, title, body, extraCss = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="${C.text}" font-family="${FONT}" font-size="12" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
.lbl{font-size:12px;font-weight:700;letter-spacing:2px}
.cap{font-size:10px;letter-spacing:1.5px}
.px{opacity:0;animation:px .45s steps(2,end) forwards}
@keyframes px{to{opacity:1}}
.fade{opacity:0;animation:fade .7s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.pulse{animation:pulse 1.6s steps(2,end) infinite}
@keyframes pulse{50%{opacity:.15}}
${extraCss}
@media (prefers-reduced-motion:reduce){.px,.fade,.growx,.pulse,.tw,.scan{animation:none!important;opacity:1!important;transform:none!important}}
</style>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" fill="${C.bg}" stroke="${C.line}"/>
${body}
</svg>
`
}

// ---------------------------------------------------------------- data

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'profile-readme' },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json))
  return json.data
}

async function fetchGithub(login, now) {
  const from = new Date(now - 30 * 864e5).toISOString()
  const { user } = await gql(
    `query($login:String!,$from:DateTime!){user(login:$login){
      year:contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}
      month:contributionsCollection(from:$from){totalCommitContributions
        commitContributionsByRepository(maxRepositories:5){repository{name primaryLanguage{name}} contributions{totalCount}}}
    }}`,
    { login, from },
  )

  const cal = user.year.contributionCalendar
  const weeks = cal.weeks.map((w) => w.contributionDays)
  const days = weeks.flat()
  let longest = 0
  let run = 0
  for (const d of days) (run = d.contributionCount ? run + 1 : 0), (longest = Math.max(longest, run))
  let i = days.length - 1
  if (i >= 0 && !days[i].contributionCount) i-- // today without contributions doesn't break the streak yet
  let current = 0
  while (i >= 0 && days[i].contributionCount) current++, i--

  return {
    total: cal.totalContributions,
    weeks,
    current,
    longest,
    monthCommits: user.month.totalCommitContributions,
    byRepo: user.month.commitContributionsByRepository.map((r) => ({
      name: r.repository.name,
      language: r.repository.primaryLanguage?.name,
      count: r.contributions.totalCount,
    })),
  }
}

// ---------------------------------------------------------------- panels

function hero(now) {
  const H = 320
  const rand = rng(7)
  const parts = []

  // top & bottom bars
  parts.push(
    `<line x1="0" y1="38" x2="${W}" y2="38" stroke="${C.line}"/><line x1="0" y1="274" x2="${W}" y2="274" stroke="${C.line}"/>`,
    t(28, 24, 'PORTFOLIO / GITHUB', `class="cap" fill="${C.mid}"`),
  )

  // big pixel name
  profile.name.forEach((line, i) => {
    const y = 58 + i * 66, delay = 0.1 + i * 0.25
    parts.push(pixelText(line, 30, y, 8, { delay, spread: 0.7, rand }).svg)
  })

  // typed role with block cursor
  const role = profile.role
  const cw = 9.2
  const steps = Array.from({ length: role.length + 1 }, (_, k) => r2(k * cw))
  const typeDur = (role.length * 0.055).toFixed(2)
  const rx = 52
  parts.push(
    `<defs><clipPath id="type"><rect x="${rx}" y="196" height="24" width="0"><animate attributeName="width" values="${steps.join(';')}" dur="${typeDur}s" begin="1.1s" fill="freeze" calcMode="discrete"/></rect></clipPath></defs>`,
    t(30, 214, '>', `fill="${C.dim}" font-size="16"`),
    `<text x="${rx}" y="214" font-size="16" fill="${C.hi}" textLength="${r2(role.length * cw)}" lengthAdjust="spacing" clip-path="url(#type)">${esc(role)}</text>`,
    `<rect x="${rx}" y="200" width="9" height="17" fill="${C.hi}"><animate attributeName="x" values="${steps.map((s) => r2(rx + s + 2)).join(';')}" dur="${typeDur}s" begin="1.1s" fill="freeze" calcMode="discrete"/><animate attributeName="opacity" values="1;0" dur="1s" repeatCount="indefinite" calcMode="discrete"/></rect>`,
    `<g class="fade" style="animation-delay:2s">${t(30, 244, profile.tools, `fill="${C.dim}"`)}</g>`,
  )

  // status bar
  parts.push(
    `<rect class="pulse" x="28" y="292" width="7" height="7" fill="${LEVELS[4]}"/>`,
    t(44, 299, 'STATUS', `class="cap"`),
    t(104, 299, profile.status, `class="cap" fill="${C.text}"`),
    t(W - 28, 299, profile.tagline, `class="cap" text-anchor="end"`),
  )

  // dithered planet (ordered 4x4 Bayer dithering)
  const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
  const X0 = 512, Y0 = 50, AW = 344, AH = 214, S = 6
  const CX = X0 + AW / 2, CY = Y0 + AH / 2, R = 80
  const L = [-0.48, -0.52, 0.71]
  const tilt = -0.3
  const lit = []
  for (let j = 0; j < AH / S; j++) {
    for (let i = 0; i < AW / S; i++) {
      const px = X0 + i * S, py = Y0 + j * S
      const dx = (px + S / 2 - CX) / R, dy = (py + S / 2 - CY) / R
      const d2 = dx * dx + dy * dy
      let b = 0
      if (d2 < 1) b = 0.07 + 0.93 * Math.max(0, dx * L[0] + dy * L[1] + Math.sqrt(1 - d2) * L[2]) ** 1.3
      const u = dx * Math.cos(tilt) - dy * Math.sin(tilt)
      const v = dx * Math.sin(tilt) + dy * Math.cos(tilt)
      const ring = (u / 1.95) ** 2 + (v / 0.42) ** 2
      if (ring > 0.6 && ring < 1 && !(d2 < 1 && v < 0)) b = ring < 0.78 ? 0.35 : 0.9
      const star = d2 >= 1 && b === 0 && rand() < 0.008
      if (star) b = 1
      if (b > (bayer[j % 4][i % 4] + 0.5) / 16) lit.push([px, py, star ? rand() * 0.14 : rand()])
    }
  }
  const art = lit
    .map(([x, y, r]) => (r < 0.14 ? `<rect class="tw tw${Math.floor(r * 28.6)}" x="${x}" y="${y}" width="${S - 1}" height="${S - 1}"/>` : `<rect x="${x}" y="${y}" width="${S - 1}" height="${S - 1}"/>`))
    .join('')
  parts.push(
    `<defs><clipPath id="reveal"><rect x="${X0}" y="${Y0}" width="${AW}" height="0"><animate attributeName="height" values="0;${AH}" dur="1.6s" begin=".3s" fill="freeze" calcMode="spline" keySplines=".2 .7 .2 1"/></rect></clipPath></defs>`,
    `<g clip-path="url(#reveal)" fill="#e6e6e6">${art}</g>`,
    `<rect class="scan" x="${X0}" y="${Y0}" width="${AW}" height="2" fill="${C.hi}" opacity=".18"/>`,
  )

  const css = `.tw{animation:tw 3s steps(3,end) infinite}
.tw0{animation-duration:2.3s}.tw1{animation-duration:3.1s}.tw2{animation-duration:3.9s;animation-delay:.7s}.tw3{animation-duration:4.6s;animation-delay:1.3s}
@keyframes tw{50%{opacity:.1}}
.scan{animation:scan 5s linear infinite}
@keyframes scan{from{transform:translateY(0)}to{transform:translateY(${AH}px)}}`

  const alt = `${profile.name.join(' ')} — ${profile.role}. ${profile.status}.`
  return svg(W, H, alt, parts.join('\n'), css)
}

function about() {
  const parts = []
  let d = 0.1

  // 01 / SOBRE — short, left column
  parts.push(label(28, 46, '01 / SOBRE', d))
  profile.about.forEach((line, i) => parts.push(`<g class="fade" style="animation-delay:${(d += 0.08).toFixed(2)}s">${t(28, 76 + i * 19, line, 'font-size="13"')}</g>`))

  // 02 / STACK — one row per group: label, then chips
  const X = 320, CX = X + 136
  d = 0.2
  parts.push(`<line x1="296" y1="28" x2="296" y2="PANEL_BOTTOM" stroke="${C.line}"/>`, label(X, 46, '02 / STACK', d))
  profile.stack.forEach((g, row) => {
    const y = 62 + row * 34
    parts.push(`<g class="fade" style="animation-delay:${(d += 0.1).toFixed(2)}s">${t(X, y + 16, g.label, 'class="cap"')}</g>`)
    let x = CX
    for (const item of g.items) {
      const w = Math.round(item.length * 7.25 + 28)
      parts.push(
        `<g class="fade" style="animation-delay:${(d += 0.04).toFixed(2)}s"><rect x="${x + 0.5}" y="${y + 0.5}" width="${w}" height="23" fill="#111" stroke="#2a2a2a"/><rect x="${x + 8}" y="${y + 8}" width="7" height="7" fill="${COLORS[item] ?? C.mid}"/>${t(x + 21, y + 16, item, `fill="#dcdcdc"`)}</g>`,
      )
      x += w + 6
    }
  })

  const H = Math.max(76 + (profile.about.length - 1) * 19, 62 + profile.stack.length * 34) + 26
  const alt = `Sobre: ${profile.about.join(' ')} Stack: ${profile.stack.flatMap((g) => g.items).join(', ')}.`
  return svg(W, H, alt, parts.join('\n').replace('PANEL_BOTTOM', H - 28))
}

function activity(gh) {
  const parts = []

  parts.push(
    label(28, 46, '03 / COMMITS', 0.1),
    `<g class="fade" style="animation-delay:.2s">${t(W - 28, 44, `SEQUÊNCIA ATUAL ${gh.current}D · MAIOR ${gh.longest}D`, 'class="cap" text-anchor="end"')}</g>`,
  )

  // contribution graph, same scale and layout as the one on the GitHub profile
  const weeks = gh.weeks
  const GX = 60, GY = 104
  const step = Math.floor((W - 28 - GX) / weeks.length)
  const CS = step - 3
  const counts = weeks.flat().map((d) => d.contributionCount).filter(Boolean).sort((a, b) => a - b)
  const q = (p) => counts[Math.floor((counts.length - 1) * p)] ?? 1
  const level = (c) => (!c ? 0 : c <= q(0.25) ? 1 : c <= q(0.5) ? 2 : c <= q(0.75) ? 3 : 4)

  parts.push(`<g class="fade" style="animation-delay:.2s">${t(28, 74, `${gh.total} contribuições no último ano`, `font-size="13" fill="${C.hi}"`)}</g>`)
  ;[[1, 'SEG'], [3, 'QUA'], [5, 'SEX']].forEach(([r, l]) => parts.push(t(28, GY + r * step + CS - 1, l, 'class="cap" font-size="9"')))
  let lastMonth = -1
  weeks.forEach((week, col) => {
    const x = GX + col * step
    const m = new Date(week[0].date + 'T12:00:00').getMonth()
    const tooShort = col === 0 && new Date(weeks[2][0].date + 'T12:00:00').getMonth() !== m
    if (m !== lastMonth && !tooShort && col < weeks.length - 2) parts.push(t(x, GY - 8, MONTHS[m], 'class="cap" font-size="9"'))
    lastMonth = m
    const cells = week.map((d) => {
      const row = new Date(d.date + 'T12:00:00').getDay()
      return `<rect x="${x}" y="${GY + row * step}" width="${CS}" height="${CS}" rx="2" fill="${LEVELS[level(d.contributionCount)]}"><title>${d.date}: ${d.contributionCount}</title></rect>`
    })
    parts.push(`<g class="fade" style="animation-delay:${(0.3 + col * 0.018).toFixed(3)}s">${cells.join('')}</g>`)
  })
  const last = weeks.at(-1).at(-1)
  const lx = GX + (weeks.length - 1) * step, ly = GY + new Date(last.date + 'T12:00:00').getDay() * step
  parts.push(`<rect class="pulse" x="${lx - 2}" y="${ly - 2}" width="${CS + 4}" height="${CS + 4}" rx="3" fill="none" stroke="${C.hi}"/>`)
  const sweep = weeks.map((_, c) => GX - 2 + c * step).join(';')
  parts.push(`<rect x="${GX - 2}" y="${GY - 2}" width="${CS + 4}" height="${7 * step + 1}" rx="3" fill="none" stroke="${C.hi}" stroke-opacity=".22"><animate attributeName="x" values="${sweep}" dur="${(weeks.length * 0.12).toFixed(1)}s" begin="1.4s" repeatCount="indefinite" calcMode="discrete"/></rect>`)

  const legendY = GY + 7 * step + 10
  const lgX = W - 28 - 5 * 14 - 30
  parts.push(t(lgX - 8, legendY + 9, 'MENOS', 'class="cap" font-size="9" text-anchor="end"'))
  LEVELS.forEach((c, i) => parts.push(`<rect x="${lgX + i * 14}" y="${legendY}" width="10" height="10" rx="2" fill="${c}"/>`))
  parts.push(t(lgX + 5 * 14 + 4, legendY + 9, 'MAIS', 'class="cap" font-size="9"'))

  // last 30 days, per repository — like GitHub's "Contribution activity"
  const ay = legendY + 40
  parts.push(
    `<line x1="28" y1="${ay - 14}" x2="${W - 28}" y2="${ay - 14}" stroke="${C.line}"/>`,
    t(28, ay + 14, `${gh.monthCommits} commits em ${gh.byRepo.length} repositórios`, `font-size="13" fill="${C.hi}"`),
    t(W - 28, ay + 14, 'ÚLTIMOS 30 DIAS', 'class="cap" text-anchor="end"'),
  )
  const max = Math.max(1, ...gh.byRepo.map((r) => r.count))
  const BX = 520, BW = W - 28 - BX
  gh.byRepo.forEach((r, i) => {
    const y = ay + 44 + i * 22
    const delay = (0.9 + i * 0.12).toFixed(2)
    parts.push(
      `<g class="fade" style="animation-delay:${delay}s"><rect x="28" y="${y - 8}" width="7" height="7" fill="${COLORS[r.language] ?? C.mid}"/>${t(44, y, trunc(r.name, 40), 'fill="#dcdcdc"')}${t(BX - 16, y, `${r.count} commits`, `fill="${C.dim}" text-anchor="end"`)}</g>`,
      `<rect class="growx" x="${BX}" y="${y - 8}" width="${Math.max(6, Math.round((r.count / max) * BW))}" height="7" rx="2" fill="${LEVELS[3]}" style="animation-delay:${delay}s"/>`,
    )
  })

  const H = ay + 44 + gh.byRepo.length * 22 + 8
  const css = `.growx{transform-box:fill-box;transform-origin:left;transform:scaleX(0);animation:growx .8s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes growx{to{transform:scaleX(1)}}`
  const alt = `${gh.total} contribuições no último ano; sequência atual de ${gh.current} dias, maior de ${gh.longest} dias. Últimos 30 dias: ${gh.monthCommits} commits — ${gh.byRepo.map((r) => `${r.name} (${r.count})`).join(', ')}.`
  return svg(W, H, alt, parts.join('\n'), css)
}

function readme() {
  const img = (src, alt) => `<img src="${src}" width="100%" alt="${esc(alt)}" />`
  const links = profile.links.map((l) => `<a href="${l.url}"><code>${l.label}</code></a>`).join(' &nbsp;·&nbsp; ')
  return `<!-- Gerado por scripts/generate.mjs — edite data/profile.json, não este arquivo. -->

<div align="center">

${img('./assets/hero.svg', `${profile.name.join(' ')} — ${profile.role}`)}
${img('./assets/about.svg', 'Sobre e stack')}
${img('./assets/activity.svg', 'Gráfico de contribuições e commits recentes por repositório')}

<br />

${links}

</div>
`
}

// ---------------------------------------------------------------- main

const now = new Date()
const gh = await fetchGithub(profile.login, now)
const out = (p) => new URL(p, ROOT)

await writeFile(out('assets/hero.svg'), hero(now))
await writeFile(out('assets/about.svg'), about())
await writeFile(out('assets/activity.svg'), activity(gh))
await writeFile(out('README.md'), readme())

console.log(`ok: ${gh.total} contributions, ${gh.monthCommits} commits in the last 30 days across ${gh.byRepo.length} repos`)
