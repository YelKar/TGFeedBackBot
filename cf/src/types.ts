export type PostStatus = 'pending' | 'scheduled' | 'rejected' | 'published'

export interface PostRow {
    id: string
    user_id: number
    username: string
    text: string
    status: PostStatus
    created_at: number // epoch ms
    admin_msg_id: number | null
    publish_at: number | null // epoch ms
    sequence_number: number | null
}

export interface VoteRow {
    post_id: string
    admin_id: number
    admin_username: string | null
    vote: number
}

export interface DialogueRow {
    user_msg_id: number
    admin_msg_id: number
    post_id: string
}

export interface SchedulerConfig {
    preferred_slots: string[]
    min_interval: number // секунды
    window_start: number // час начала окна
    window_end: number // час конца окна
    posts_per_day: number
}
