const ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>]/g, (ch) => ESCAPE_MAP[ch])
}

const UNESCAPE_MAP: Record<string, string> = {
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&amp;': '&',
}

export function unescapeHtml(text: string): string {
    return text.replace(/&(lt|gt|quot|#39|amp);/g, (m) => UNESCAPE_MAP[m] ?? m)
}

export function stripHtml(html: string): string {
    return unescapeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
}

interface TgEntity {
    offset: number
    length: number
    type: string
    url?: string
    user?: { id: number }
}

function tagFor(e: TgEntity): { open: string; close: string } | null {
    switch (e.type) {
        case 'bold':
            return { open: '<b>', close: '</b>' }
        case 'italic':
            return { open: '<i>', close: '</i>' }
        case 'underline':
            return { open: '<u>', close: '</u>' }
        case 'strikethrough':
            return { open: '<s>', close: '</s>' }
        case 'spoiler':
            return { open: '<tg-spoiler>', close: '</tg-spoiler>' }
        case 'code':
            return { open: '<code>', close: '</code>' }
        case 'pre':
            return { open: '<pre>', close: '</pre>' }
        case 'blockquote':
            return { open: '<blockquote>', close: '</blockquote>' }
        case 'expandable_blockquote':
            return { open: '<blockquote expandable>', close: '</blockquote>' }
        case 'text_link':
            return { open: `<a href="${e.url ?? ''}">`, close: '</a>' }
        case 'text_mention':
            return { open: `<a href="tg://user?id=${e.user?.id ?? ''}">`, close: '</a>' }
        default:
            return null
    }
}

// Оффсеты Telegram заданы в UTF-16 кодовых единицах и совпадают с индексами JS-строки
export function toHtml(text: string, entities: TgEntity[] = []): string {
    if (!entities.length) return escapeHtml(text)

    type Ev = { pos: number; open: boolean; tag: { open: string; close: string } }
    const events: Ev[] = []

    for (const e of entities) {
        const tag = tagFor(e)
        if (!tag) continue
        events.push({ pos: e.offset, open: true, tag })
        events.push({ pos: e.offset + e.length, open: false, tag })
    }

    // По позиции; в одной точке сначала закрываем предыдущее, потом открываем новое
    events.sort((a, b) => (a.pos !== b.pos ? a.pos - b.pos : a.open ? 1 : -1))

    let out = ''
    let pos = 0
    const pushText = (to: number): void => {
        if (to > pos) out += escapeHtml(text.slice(pos, to))
        pos = Math.max(pos, to)
    }

    for (const ev of events) {
        pushText(Math.min(ev.pos, text.length))
        out += ev.open ? ev.tag.open : ev.tag.close
    }
    pushText(text.length)

    return out
}
