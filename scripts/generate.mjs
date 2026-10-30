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
const C = { bg: '#0a0a0a', line: '#222', dim: '#5e5e5e', mid: '#8e8e8e', text: '#b4b4b4', hi: '#f2f2f2', green: '#39d353' }
// GitHub's dark contribution scale
const LEVELS = ['#1c2128', '#0e4429', '#006d32', '#26a641', '#39d353']
// GitHub linguist colors (C is lightened so it shows on black)
const COLORS = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', CSS: '#663399', HTML: '#e34c26', C: '#a8b9cc', Python: '#3572a5',
  Go: '#00add8', Java: '#b07219', PostgreSQL: '#336791', React: '#61dafb', 'React Native': '#61dafb', Vite: '#646cff',
  Docker: '#2496ed', Linux: '#fcc624', Git: '#f05032', n8n: '#ea4b71', 'APIs REST': '#39d353', 'Agentes de IA': '#d97757',
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
  return `<g class="fade" style="animation-delay:${delay}s"><rect x="${x}" y="${y - 8}" width="7" height="7" fill="${C.green}"/>${t(x + 15, y, text, `class="lbl"`)}</g>`
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
    const y = 58 + i * 66, delay = 0.1 + i * 0.25
    const body = line.replace(/\.$/, '')
    const text = pixelText(body, 30, y, 8, { delay, spread: 0.7, rand })
    parts.push(text.svg)
    if (body !== line) parts.push(pixelText('.', 30 + text.width + 16, y, 8, { delay: delay + 0.8, spread: 0, fill: C.green, rand }).svg)
  })

  // typed role with block cursor
  const role = profile.role
  const cw = 9.2
  const steps = Array.from({ length: role.length + 1 }, (_, k) => r2(k * cw))
  const typeDur = (role.length * 0.055).toFixed(2)
  const rx = 52
  parts.push(
    `<defs><clipPath id="type"><rect x="${rx}" y="196" height="24" width="0"><animate attributeName="width" values="${steps.join(';')}" dur="${typeDur}s" begin="1.1s" fill="freeze" calcMode="discrete"/></rect></clipPath></defs>`,
    t(30, 214, '>', `fill="${C.green}" font-size="16"`),
    `<text x="${rx}" y="214" font-size="16" fill="${C.hi}" textLength="${r2(role.length * cw)}" lengthAdjust="spacing" clip-path="url(#type)">${esc(role)}</text>`,
    `<rect x="${rx}" y="200" width="9" height="17" fill="${C.green}"><animate attributeName="x" values="${steps.map((s) => r2(rx + s + 2)).join(';')}" dur="${typeDur}s" begin="1.1s" fill="freeze" calcMode="discrete"/><animate attributeName="opacity" values="1;0" dur="1s" repeatCount="indefinite" calcMode="discrete"/></rect>`,
    `<g class="fade" style="animation-delay:2s">${t(30, 244, profile.tools, `fill="${C.dim}"`)}</g>`,
  )

  // status bar
  parts.push(
    `<rect class="pulse" x="28" y="292" width="7" height="7" fill="${C.green}"/>`,
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
      if (b > (bayer[j % 4][i % 4] + 0.5) / 16) lit.push([px, py, star ? rand() * 0.14 : rand(), star])
    }
  }
  const art = lit
    .map(([x, y, r, star]) => (r < 0.14 ? `<rect class="tw tw${Math.floor(r * 28.6)}" x="${x}" y="${y}" width="${S - 1}" height="${S - 1}"${star ? ` fill="${C.green}"` : ''}/>` : `<rect x="${x}" y="${y}" width="${S - 1}" height="${S - 1}"/>`))
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
    `<line x1="32" y1="${ty}" x2="32" y2="${ty + lineH}" stroke="${LEVELS[2]}" stroke-dasharray="${lineH}" stroke-dashoffset="${lineH}"><animate attributeName="stroke-dashoffset" values="${lineH};0" dur="1.2s" begin="${d.toFixed(2)}s" fill="freeze"/></line>`,
  )
  tl.forEach((e, i) => {
    const y = ty + i * 40
    const dot = e.current
      ? `<rect class="pulse" x="28" y="${y - 4}" width="9" height="9" fill="${C.green}"/>`
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
      const w = Math.round(item.length * 7.25 + 32)
      if (x + w > XMAX) (x = X), (y += 32)
      parts.push(
        `<g class="fade" style="animation-delay:${(d += 0.05).toFixed(2)}s"><rect x="${x + 0.5}" y="${y + 0.5}" width="${w}" height="24" fill="#111" stroke="#2e2e2e"/><rect x="${x + 10}" y="${y + 9}" width="7" height="7" fill="${COLORS[item] ?? C.mid}"/>${t(x + 24, y + 17, item, `fill="#dcdcdc"`)}</g>`,
      )
      x += w + 8
    }
    y += 54
  }

  // 04 / FOCO
  parts.push(label(X, y + 4, '04 / FOCO', (d += 0.1)))
  ;['sistemas internos em produção', 'integrações REST com parceiros', 'automação com n8n + agentes de IA'].forEach((f, i) => {
    parts.push(`<g class="fade" style="animation-delay:${(d += 0.1).toFixed(2)}s">${t(X, y + 34 + i * 20, '›', `fill="${C.green}"`)}${t(X + 16, y + 34 + i * 20, f, 'font-size="13"')}</g>`)
  })

  const H = Math.max(ty + lineH + 52, y + 34 + 2 * 20 + 28)
  parts.push(`<line x1="476" y1="28" x2="476" y2="${H - 28}" stroke="${C.line}"/>`)
  const alt = `Sobre: ${profile.about.join(' ')} Trajetória: ${tl.map((e) => `${e.title}, ${e.org} (${e.period})`).join('; ')}. Stack: ${profile.stack.flatMap((g) => g.items).join(', ')}.`
  return svg(W, H, alt, parts.join('\n'))
}

function activity(gh, now) {
  const parts = []

  parts.push(
    label(28, 46, '05 / ATIVIDADE', 0.1),
    `<g class="fade" style="animation-delay:.2s">${t(W - 28, 44, `SINCRONIZADO VIA GITHUB API · ${stamp(now)}`, 'class="cap" text-anchor="end"')}</g>`,
  )

  // stats
  ;[
    [gh.commits, 'COMMITS · 12 MESES'],
    [gh.prs, 'PULL REQUESTS'],
    [`${gh.current}d`, 'SEQUÊNCIA ATUAL'],
    [`${gh.longest}d`, 'MAIOR SEQUÊNCIA'],
  ].forEach(([v, l], i) => {
    const x = 28 + i * 212
    parts.push(`<g class="fade" style="animation-delay:${(0.2 + i * 0.08).toFixed(2)}s">${t(x, 88, v, `font-size="24" font-weight="700" fill="${C.green}"`)}${t(x, 106, l, 'class="cap"')}</g>`)
  })
  parts.push(`<line x1="28" y1="128" x2="${W - 28}" y2="128" stroke="${C.line}"/>`)

  // active projects: one row per repo with its daily commits
  const DAYS = 45, BW = 5, BG = 2, SX = 330
  parts.push(t(28, 156, 'PROJETOS ATIVOS', 'class="cap"'), t(SX, 156, `COMMITS POR DIA · ${DAYS} DIAS`, 'class="cap"'))
  const rows = gh.featured.map((repo) => {
    const buckets = Array(DAYS).fill(0)
    for (const c of repo.commits) {
      const d = Math.floor((now - new Date(c.committedDate)) / 864e5)
      if (d < DAYS) buckets[DAYS - 1 - d]++
    }
    return { repo, buckets }
  })
  const max = Math.max(1, ...rows.flatMap((r) => r.buckets))
  rows.forEach(({ repo, buckets }, i) => {
    const y = 186 + i * 30
    const delay = 0.5 + i * 0.12
    const bars = buckets.map((b, k) => {
      const h = b ? Math.max(4, Math.round((b / max) * 20 / 4) * 4) : 2
      const fill = b ? LEVELS[Math.min(4, 1 + Math.ceil((b / max) * 3))] : LEVELS[0]
      return `<rect class="grow" x="${SX + k * (BW + BG)}" y="${y + 2 - h}" width="${BW}" height="${h}" fill="${fill}" style="animation-delay:${(delay + k * 0.01).toFixed(2)}s"/>`
    })
    parts.push(
      `<g class="fade" style="animation-delay:${delay.toFixed(2)}s"><rect x="28" y="${y - 8}" width="8" height="8" fill="${COLORS[repo.language] ?? C.mid}"/>` +
        t(44, y, trunc(repo.name, 30), `font-size="13" fill="${C.hi}"`) +
        t(W - 140, y, `${repo.total} commits`, `fill="${C.text}" text-anchor="end"`) +
        t(W - 28, y, ago(repo.pushedAt, now), `fill="${C.dim}" text-anchor="end"`) +
        `</g>${bars.join('')}`,
    )
  })

  // git log
  const ly = 186 + rows.length * 30
  parts.push(`<line x1="28" y1="${ly}" x2="${W - 28}" y2="${ly}" stroke="${C.line}"/>`)
  parts.push(`<g class="fade" style="animation-delay:1.1s">${t(28, ly + 30, '$', `fill="${C.green}" font-weight="700"`)}${t(44, ly + 30, `git log --author=pedro --all-repos --oneline -n ${gh.log.length}`, `fill="${C.mid}"`)}</g>`)
  gh.log.forEach((c, i) => {
    const y = ly + 58 + i * 20
    parts.push(
      `<g class="fade" style="animation-delay:${(1.4 + i * 0.18).toFixed(2)}s">` +
        t(28, y, c.abbreviatedOid.slice(0, 7), `fill="${LEVELS[3]}"`) +
        t(96, y, trunc(c.repo, 24), `fill="#dcdcdc"`) +
        t(286, y, trunc(c.messageHeadline, 66), `fill="${C.mid}"`) +
        t(W - 28, y, ago(c.committedDate, now), `fill="${C.dim}" text-anchor="end"`) +
        `</g>`,
    )
  })
  const cy = ly + 58 + gh.log.length * 20
  parts.push(`<rect x="28" y="${cy - 12}" width="8" height="14" fill="${C.green}"><animate attributeName="opacity" values="1;0" dur="1s" repeatCount="indefinite" calcMode="discrete"/></rect>`)

  const css = `.grow{transform-box:fill-box;transform-origin:bottom;transform:scaleY(0);animation:grow .4s steps(3,end) forwards}
@keyframes grow{to{transform:scaleY(1)}}`
  const alt = `Atividade no GitHub: ${gh.commits} commits nos últimos 12 meses, ${gh.prs} pull requests, sequência atual de ${gh.current} dias, maior sequência de ${gh.longest} dias. Projetos ativos: ${gh.featured.map((r) => `${r.name} (${r.total} commits)`).join(', ')}. Commits recentes: ${gh.log.map((c) => `${c.repo}: ${c.messageHeadline}`).join('; ')}.`
  return svg(W, cy + 26, alt, parts.join('\n'), css)
}

function readme() {
  const img = (src, alt) => `<img src="${src}" width="100%" alt="${esc(alt)}" />`
  const links = profile.links.map((l) => `<a href="${l.url}"><code>${l.label}</code></a>`).join(' &nbsp;·&nbsp; ')
  return `<!-- Gerado por scripts/generate.mjs — edite data/profile.json, não este arquivo. -->

<div align="center">

${img('./assets/hero.svg', `${profile.name.join(' ')} — ${profile.role}`)}
${img('./assets/about.svg', 'Sobre, trajetória e stack')}
${img('./assets/activity.svg', 'Atividade no GitHub, projetos ativos e commits recentes')}

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
await writeFile(out('assets/activity.svg'), activity(gh, now))
await writeFile(out('README.md'), readme())

console.log(`ok: ${gh.total} contributions, ${gh.log.length} log lines, featured: ${gh.featured.map((r) => r.name).join(', ')}`)
