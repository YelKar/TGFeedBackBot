export interface Env {
    TOKEN: string
    CHAT_ID: string // ID чата модерации
    CHANNEL_ID: string // ID канала публикации
    WEBHOOK_SECRET?: string
    DB: D1Database
    MODERATION: DurableObjectNamespace
}
