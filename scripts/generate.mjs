// Generates the profile README and its animated SVG panels from
// data/profile.json + live GitHub data (GraphQL API).
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/generate.mjs
//
// Runs daily in .github/workflows/profile.yml.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { layout } from './pixelfont.mjs'

const ROOT = new URL('..', import.meta.url)
const profile = JSON.parse(await readFile(new URL('data/profile.json', ROOT), 'utf8'))
const token = process.env.GITHUB_TOKEN
if (!token) throw new Error('GITHUB_TOKEN is required')

const W = 880
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
const LEVELS = ['#161616', '#3b3b3b', '#6d6d6d', '#ababab', '#f2f2f2']
const C = { bg: '#0a0a0a', line: '#222', dim: '#5e5e5e', mid: '#8e8e8e', text: '#b4b4b4', hi: '#f2f2f2' }

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

function wrap(text, width) {
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width) lines.push(line), (line = word)
    else line = (line + ' ' + word).trim()
  }
  if (line) lines.push(line)
  return lines
}

function ago(iso, now) {
  const d = Math.floor((now - new Date(iso)) / 864e5)
  if (d <= 0) return 'hoje'
  if (d === 1) return 'ontem'
  if (d < 14) return `há ${d}d`
  if (d < 60) return `há ${Math.floor(d / 7)} sem`
  if (d < 365) return `há ${Math.floor(d / 30)} meses`
  return `há ${Math.floor(d / 365)}a`
}

const stamp = (d) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(d)
    .replaceAll('/', '.')

const t = (x, y, s, attrs = '') => `<text x="${r2(x)}" y="${r2(y)}" ${attrs}>${esc(s)}</text>`

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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
text{font-family:${FONT};fill:${C.text};font-size:12px}
.lbl{fill:${C.hi};font-size:12px;font-weight:700;letter-spacing:2px}
.cap{fill:${C.dim};font-size:10px;letter-spacing:1.5px}
.px{opacity:0;animation:px .45s steps(2,end) forwards}
@keyframes px{to{opacity:1}}
.fade{opacity:0;animation:fade .7s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.pulse{animation:pulse 1.6s steps(2,end) infinite}
@keyframes pulse{50%{opacity:.15}}
${extraCss}
@media (prefers-reduced-motion:reduce){.px,.fade,.grow,.pulse,.tw,.scan{animation:none!important;opacity:1!important;transform:none!important}}
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
  const since = new Date(now - 26 * 7 * 864e5).toISOString()
  const { user } = await gql(
    `query($login:String!,$since:GitTimestamp!){user(login:$login){
      pinnedItems(first:6,types:REPOSITORY){nodes{...on Repository{name}}}
      contributionsCollection{totalCommitContributions totalPullRequestContributions
        contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}
      repositories(first:30,ownerAffiliations:OWNER,privacy:PUBLIC,isFork:false,orderBy:{field:PUSHED_AT,direction:DESC}){nodes{
        name description url pushedAt stargazerCount primaryLanguage{name}
        defaultBranchRef{target{...on Commit{
          all:history(first:1){totalCount}
          recent:history(first:100,since:$since){nodes{abbreviatedOid messageHeadline committedDate parents(first:1){totalCount} author{user{login}}}}
        }}}
      }}
    }}`,
    { login, since },
  )

  const mine = (c) => c.author?.user?.login?.toLowerCase() === login.toLowerCase() && c.parents.totalCount < 2
  const repos = user.repositories.nodes
    .filter((r) => r.name.toLowerCase() !== login.toLowerCase() && r.defaultBranchRef)
    .map((r) => ({
      name: r.name,
      description: r.description,
      url: r.url,
      pushedAt: r.pushedAt,
      stars: r.stargazerCount,
      language: r.primaryLanguage?.name ?? '—',
      total: r.defaultBranchRef.target.all.totalCount,
      commits: r.defaultBranchRef.target.recent.nodes.filter(mine).map((c) => ({ ...c, repo: r.name })),
    }))

  const pinned = user.pinnedItems.nodes.map((n) => n.name)
  const pick = profile.featured.length ? profile.featured : pinned
  const featured = (
    pick.length
      ? pick.map((n) => repos.find((r) => r.name === n)).filter(Boolean)
      : [...repos].sort((a, b) => b.commits.length - a.commits.length || new Date(b.pushedAt) - new Date(a.pushedAt))
  ).slice(0, 4)

  const log = repos
    .flatMap((r) => r.commits)
    .sort((a, b) => new Date(b.committedDate) - new Date(a.committedDate))
    .slice(0, 6)

  const cc = user.contributionsCollection
  const weeks = cc.contributionCalendar.weeks.map((w) => w.contributionDays)
  const days = weeks.flat()
  let longest = 0
  let run = 0
  for (const d of days) (run = d.contributionCount ? run + 1 : 0), (longest = Math.max(longest, run))
  let i = days.length - 1
  if (i >= 0 && !days[i].contributionCount) i-- // today without contributions doesn't break the streak yet
  let current = 0
  while (i >= 0 && days[i].contributionCount) current++, i--

  return {
    total: cc.contributionCalendar.totalContributions,
    commits: cc.totalCommitContributions,
    prs: cc.totalPullRequestContributions,
    current,
    longest,
    weeks,
    featured,
    log,
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
    parts.push(pixelText(line, 30, 58 + i * 66, 8, { delay: 0.1 + i * 0.25, spread: 0.7, rand }).svg)
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
    `<rect class="pulse" x="28" y="292" width="7" height="7" fill="${C.hi}"/>`,
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

  // 01 / SOBRE
  parts.push(label(28, 46, '01 / SOBRE', d))
  profile.about.forEach((line, i) => parts.push(`<g class="fade" style="animation-delay:${(d += 0.08).toFixed(2)}s">${t(28, 76 + i * 20, line, 'font-size="13"')}</g>`))

  // 02 / TRAJETÓRIA
  const ty = 206
  const tl = profile.timeline
  const lineH = (tl.length - 1) * 40
  parts.push(
    label(28, 180, '02 / TRAJETÓRIA', (d += 0.1)),
    `<line x1="32" y1="${ty}" x2="32" y2="${ty + lineH}" stroke="#333" stroke-dasharray="${lineH}" stroke-dashoffset="${lineH}"><animate attributeName="stroke-dashoffset" values="${lineH};0" dur="1.2s" begin="${d.toFixed(2)}s" fill="freeze"/></line>`,
  )
  tl.forEach((e, i) => {
    const y = ty + i * 40
    const dot = e.current
      ? `<rect class="pulse" x="28" y="${y - 4}" width="9" height="9" fill="${C.hi}"/>`
      : `<rect x="28.5" y="${y - 3.5}" width="8" height="8" fill="${C.bg}" stroke="#555"/>`
    parts.push(
      `<g class="fade" style="animation-delay:${(d += 0.15).toFixed(2)}s">${dot}${t(50, y + 4, `${e.period} · ${e.org.toUpperCase()}`, `class="cap"`)}${t(50, y + 22, e.title, `font-size="13" fill="${e.current ? C.hi : C.text}"`)}</g>`,
    )
  })

  // 03 / STACK
  const X = 504, XMAX = W - 28
  d = 0.2
  parts.push(label(X, 46, '03 / STACK', d))
  let y = 78
  for (const g of profile.stack) {
    parts.push(`<g class="fade" style="animation-delay:${(d += 0.1).toFixed(2)}s">${t(X, y, g.label, 'class="cap"')}</g>`)
    let x = X
    y += 12
    for (const item of g.items) {
      const w = Math.round(item.length * 7.25 + 20)
      if (x + w > XMAX) (x = X), (y += 32)
      parts.push(
        `<g class="fade" style="animation-delay:${(d += 0.05).toFixed(2)}s"><rect x="${x + 0.5}" y="${y + 0.5}" width="${w}" height="24" fill="#111" stroke="#2e2e2e"/>${t(x + w / 2 + 0.5, y + 17, item, `text-anchor="middle" fill="#dcdcdc"`)}</g>`,
      )
      x += w + 8
    }
    y += 54
  }

  // 04 / FOCO
  parts.push(label(X, y + 4, '04 / FOCO', (d += 0.1)))
  ;['sistemas internos em produção', 'integrações REST com parceiros', 'automação com n8n + agentes de IA'].forEach((f, i) => {
    parts.push(`<g class="fade" style="animation-delay:${(d += 0.1).toFixed(2)}s">${t(X, y + 34 + i * 20, '›', `fill="${C.hi}"`)}${t(X + 16, y + 34 + i * 20, f, 'font-size="13"')}</g>`)
  })

  const H = Math.max(ty + lineH + 52, y + 34 + 2 * 20 + 28)
  parts.push(`<line x1="476" y1="28" x2="476" y2="${H - 28}" stroke="${C.line}"/>`)
  const alt = `Sobre: ${profile.about.join(' ')} Trajetória: ${tl.map((e) => `${e.title}, ${e.org} (${e.period})`).join('; ')}. Stack: ${profile.stack.flatMap((g) => g.items).join(', ')}.`
  return svg(W, H, alt, parts.join('\n'))
}

function activity(gh, now) {
  const H = 426
  const rand = rng(11)
  const parts = []

  parts.push(
    label(28, 46, '05 / ATIVIDADE', 0.1),
    `<g class="fade" style="animation-delay:.2s">${t(W - 28, 44, `SINCRONIZADO VIA GITHUB API · ${stamp(now)}`, 'class="cap" text-anchor="end"')}</g>`,
  )

  // stats
  parts.push(pixelText(String(gh.total), 28, 72, 6, { delay: 0.3, spread: 0.4, rand }).svg)
  parts.push(`<g class="fade" style="animation-delay:.6s">${t(28, 132, 'CONTRIBUIÇÕES · 12 MESES', 'class="cap"')}</g>`)
  ;[
    [gh.commits, 'COMMITS'],
    [gh.prs, 'PULL REQUESTS'],
    [`${gh.current}d`, 'SEQUÊNCIA ATUAL'],
    [`${gh.longest}d`, 'MAIOR SEQUÊNCIA'],
  ].forEach(([v, l], i) => {
    const x = 28 + (i % 2) * 128, y = 172 + Math.floor(i / 2) * 44
    parts.push(`<g class="fade" style="animation-delay:${(0.7 + i * 0.1).toFixed(2)}s">${t(x, y, v, `font-size="20" font-weight="700" fill="${C.hi}"`)}${t(x, y + 16, l, 'class="cap"')}</g>`)
  })

  // contribution grid (last 32 weeks)
  const weeks = gh.weeks.slice(-32)
  const GX = 300, GY = 74, CS = 13, GAP = 4
  const counts = weeks.flat().map((d) => d.contributionCount).filter(Boolean).sort((a, b) => a - b)
  const p90 = counts[Math.floor(counts.length * 0.9)] || 1
  const level = (c) => (c ? Math.min(4, Math.ceil((4 * c) / p90)) : 0)
  let lastMonth = -1, lastLabelCol = -9
  weeks.forEach((week, col) => {
    const x = GX + col * (CS + GAP)
    const m = new Date(week[0].date + 'T12:00:00').getMonth()
    if (m !== lastMonth && col - lastLabelCol >= 3) {
      parts.push(t(x, GY - 10, MONTHS[m], 'class="cap"'))
      lastLabelCol = col
    }
    lastMonth = m
    const delay = (0.3 + col * 0.025).toFixed(3)
    const cells = week.map((d) => {
      const row = new Date(d.date + 'T12:00:00').getDay()
      return `<rect x="${x}" y="${GY + row * (CS + GAP)}" width="${CS}" height="${CS}" fill="${LEVELS[level(d.contributionCount)]}"><title>${d.date}: ${d.contributionCount}</title></rect>`
    })
    parts.push(`<g class="fade" style="animation-delay:${delay}s">${cells.join('')}</g>`)
  })
  const last = weeks.at(-1).at(-1)
  const lx = GX + (weeks.length - 1) * (CS + GAP), ly = GY + new Date(last.date + 'T12:00:00').getDay() * (CS + GAP)
  parts.push(`<rect class="pulse" x="${lx - 2.5}" y="${ly - 2.5}" width="${CS + 5}" height="${CS + 5}" fill="none" stroke="${C.hi}"/>`)
  const sweep = weeks.map((_, c) => GX - 2 + c * (CS + GAP)).join(';')
  parts.push(`<rect x="${GX - 2}" y="${GY - 2}" width="${CS + 4}" height="${7 * (CS + GAP) - GAP + 4}" fill="none" stroke="${C.hi}" stroke-opacity=".28"><animate attributeName="x" values="${sweep}" dur="${weeks.length * 0.22}s" begin="1.4s" repeatCount="indefinite" calcMode="discrete"/></rect>`)

  const legendY = GY + 7 * (CS + GAP) + 18
  parts.push(t(GX, legendY + 9, `ÚLTIMAS ${weeks.length} SEMANAS`, 'class="cap"'))
  const lgX = W - 28 - 5 * 14 - 40
  parts.push(t(lgX - 8, legendY + 9, 'MENOS', 'class="cap" text-anchor="end"'))
  LEVELS.forEach((c, i) => parts.push(`<rect x="${lgX + i * 14}" y="${legendY}" width="10" height="10" fill="${c}"/>`))
  parts.push(t(lgX + 5 * 14 + 4, legendY + 9, 'MAIS', 'class="cap"'))

  // git log
  parts.push(`<line x1="28" y1="244" x2="${W - 28}" y2="244" stroke="${C.line}"/>`)
  parts.push(`<g class="fade" style="animation-delay:1.2s">${t(28, 274, '$', `fill="${C.hi}" font-weight="700"`)}${t(44, 274, 'git log --author=pedro --all-repos --oneline -n 6', `fill="${C.mid}"`)}</g>`)
  gh.log.forEach((c, i) => {
    const y = 302 + i * 20
    parts.push(
      `<g class="fade" style="animation-delay:${(1.5 + i * 0.18).toFixed(2)}s">` +
        t(28, y, c.abbreviatedOid.slice(0, 7), `fill="${C.dim}"`) +
        t(96, y, trunc(c.repo, 24), `fill="#dcdcdc"`) +
        t(286, y, trunc(c.messageHeadline, 66), `fill="${C.mid}"`) +
        t(W - 28, y, ago(c.committedDate, now), `fill="${C.dim}" text-anchor="end"`) +
        `</g>`,
    )
  })
  const n = gh.log.length
  parts.push(`<rect x="28" y="${302 + n * 20 - 12}" width="8" height="14" fill="${C.hi}"><animate attributeName="opacity" values="1;0" dur="1s" repeatCount="indefinite" calcMode="discrete"/></rect>`)

  const alt = `Atividade no GitHub: ${gh.total} contribuições nos últimos 12 meses, ${gh.commits} commits, ${gh.prs} pull requests, sequência atual de ${gh.current} dias, maior sequência de ${gh.longest} dias. Commits recentes: ${gh.log.map((c) => `${c.repo}: ${c.messageHeadline}`).join('; ')}.`
  return svg(W, H, alt, parts.join('\n'))
}

function card(repo, now) {
  const CW = 430, CH = 168
  const parts = []
  const meta = [repo.stars ? `★ ${repo.stars}` : null, 'PÚBLICO'].filter(Boolean).join(' · ')
  parts.push(
    `<rect x="22" y="22" width="7" height="7" fill="${C.hi}"/>`,
    t(36, 29, repo.language.toUpperCase(), 'class="cap"'),
    t(CW - 22, 29, meta, 'class="cap" text-anchor="end"'),
    `<g class="fade" style="animation-delay:.1s">${t(22, 58, trunc(repo.name, 36), `font-size="17" font-weight="700" fill="${C.hi}"`)}</g>`,
  )
  const desc = repo.description || (repo.commits[0] ? `último commit: ${repo.commits[0].messageHeadline}` : 'sem descrição')
  const lines = wrap(desc, 56)
  if (lines.length > 2) lines[1] = lines[1].slice(0, 54).trimEnd() + '…'
  lines.slice(0, 2).forEach((l, i) => parts.push(`<g class="fade" style="animation-delay:.2s">${t(22, 82 + i * 16, l, `font-size="11.5" fill="${C.mid}"`)}</g>`))

  // daily commits, last 45 days
  const DAYS = 45
  const buckets = Array(DAYS).fill(0)
  for (const c of repo.commits) {
    const d = Math.floor((now - new Date(c.committedDate)) / 864e5)
    if (d < DAYS) buckets[DAYS - 1 - d]++
  }
  const max = Math.max(...buckets, 1)
  buckets.forEach((b, i) => {
    const h = b ? Math.max(4, Math.round(((b / max) * 32) / 4) * 4) : 2
    parts.push(`<rect class="grow" x="${22 + i * 4}" y="${146 - h}" width="3" height="${h}" fill="${b ? C.hi : '#2a2a2a'}" style="animation-delay:${(0.3 + i * 0.012).toFixed(3)}s"/>`)
  })
  parts.push(t(22, 160, `${DAYS} DIAS`, 'class="cap" font-size="8"'))
  parts.push(
    `<g class="fade" style="animation-delay:.5s">${t(CW - 22, 136, String(repo.total), `font-size="22" font-weight="700" fill="${C.hi}" text-anchor="end"`)}${t(CW - 22, 152, `COMMITS · PUSH ${ago(repo.pushedAt, now).toUpperCase()}`, 'class="cap" text-anchor="end"')}</g>`,
  )

  const css = `.grow{transform-box:fill-box;transform-origin:bottom;transform:scaleY(0);animation:grow .5s steps(4,end) forwards}
@keyframes grow{to{transform:scaleY(1)}}`
  const alt = `${repo.name} — ${desc}. ${repo.language}, ${repo.total} commits.`
  return svg(CW, CH, alt, parts.join('\n'), css)
}

function readme(gh) {
  const img = (src, alt, w = '100%') => `<img src="${src}" width="${w}" alt="${esc(alt)}" />`
  const cards = gh.featured.map((r) => `<a href="${r.url}">${img(`./assets/projects/${r.name}.svg`, r.name, '49%')}</a>`)
  const rows = []
  for (let i = 0; i < cards.length; i += 2) rows.push(cards.slice(i, i + 2).join('\n'))
  const links = profile.links.map((l) => `<a href="${l.url}"><code>${l.label}</code></a>`).join(' &nbsp;·&nbsp; ')
  return `<!-- Gerado por scripts/generate.mjs — edite data/profile.json, não este arquivo. -->

<div align="center">

${img('./assets/hero.svg', `${profile.name.join(' ')} — ${profile.role}`)}
${img('./assets/about.svg', 'Sobre, trajetória e stack')}
${img('./assets/activity.svg', 'Atividade no GitHub e commits recentes')}

${rows.join('\n<br />\n')}

<br />

${links}

</div>
`
}

// ---------------------------------------------------------------- main

const now = new Date()
const gh = await fetchGithub(profile.login, now)
const out = (p) => new URL(p, ROOT)

await rm(out('assets/projects/'), { recursive: true, force: true })
await mkdir(out('assets/projects/'), { recursive: true })
await writeFile(out('assets/hero.svg'), hero(now))
await writeFile(out('assets/about.svg'), about())
await writeFile(out('assets/activity.svg'), activity(gh, now))
for (const repo of gh.featured) await writeFile(out(`assets/projects/${repo.name}.svg`), card(repo, now))
await writeFile(out('README.md'), readme(gh))

console.log(`ok: ${gh.total} contributions, ${gh.log.length} log lines, featured: ${gh.featured.map((r) => r.name).join(', ')}`)
