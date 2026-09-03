export type PostStatus = 'pending' | 'scheduled' | 'rejected' | 'published'

/** Формат ответа /api — ключи совпадают со старым Python-бэкендом. */
export interface RatingStatus {
    estimation: number
    min_estimation: number
    max_estimation: number
    is_final: boolean
    is_guaranteed_approved: boolean
    is_guaranteed_rejected: boolean
}

export interface Analytics {
    res: RatingStatus
    votes_list: string
    is_approved: boolean
    is_rejected: boolean
}

export interface Post {
    id: string
    username: string
    text: string
    status: PostStatus
    publish_at: number | null // секунды
    created_at: number // секунды
    media_count: number
    analytics: Analytics
}

export type Role = 'admin' | 'user' | 'loading' | 'unauthorized'
export type AdminTab = 'pending' | 'scheduled' | 'published' | 'rejected' | 'user_view'
export type UserTab = 'active' | 'published'
export type ActionId =
    | 'vote'
    | 'reject'
    | 'schedule'
    | 'publish_now'
    | 'edit'
    | 'block'
    | 'delete'

declare global {
    interface Window {
        Telegram?: {
            WebApp?: {
                initData: string
                ready(): void
                expand(): void
                themeParams: Partial<Record<string, string>>
            }
        }
    }
}
