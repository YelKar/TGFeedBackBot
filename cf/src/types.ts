export type PostStatus = 'pending' | 'scheduled' | 'rejected' | 'published'

import type { UserFromGetMe } from '@grammyjs/types'

export interface MediaItem {
    type: 'photo' | 'video' | 'document' | 'audio'
    file_id: string
}

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
    media: string | null // JSON MediaItem[]
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

export interface MediaItem {
    type: 'photo' | 'video' | 'document' | 'audio'
    file_id: string
    caption_above?: boolean
}

export interface PublishState {
    consecutive_failures: number
    paused: boolean
    last_error: string | null
    failed_post_id: string | null
}

export interface ConfigMap {
    scheduler: SchedulerConfig
    publish_state: PublishState
    bot_info: UserFromGetMe
}
