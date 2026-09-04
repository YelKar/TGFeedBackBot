import type { ConfigMap, DialogueRow, PostRow, PostStatus, VoteRow } from './types'
import type { QueueUpdate } from './scheduler'

export interface FilteredPostsOpts {
    userId?: number
    status?: PostStatus
    limit?: number
    lastTs?: number | null // секунды, как в API
}

export class Database {
    constructor(private d1: D1Database) {}

    private async all<T>(query: string, ...values: unknown[]): Promise<T[]> {
        const res = await this.d1.prepare(query).bind(...values).all<T>()
        return (res.results ?? []) as T[]
    }

    private async run(query: string, ...values: unknown[]): Promise<void> {
        await this.d1.prepare(query).bind(...values).run()
    }

    async getFilteredPosts(opts: FilteredPostsOpts): Promise<PostRow[]> {
        const where: string[] = []
        const params: unknown[] = []

        if (opts.userId !== undefined) {
            where.push('user_id = ?')
            params.push(opts.userId)
        }
        if (opts.status) {
            where.push('status = ?')
            params.push(opts.status)
        }
        if (opts.lastTs) {
            where.push('created_at < ?')
            params.push(Math.trunc(opts.lastTs * 1000))
        }

        const sql =
            `SELECT * FROM post ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
            'ORDER BY created_at DESC LIMIT ?'
        params.push(opts.limit ?? 10)
        return this.all<PostRow>(sql, ...params)
    }

    async createPost(
        postId: string,
        userId: number,
        username: string,
        text: string,
        mediaJson: string | null = null
    ): Promise<void> {
        await this.run(
            "INSERT INTO post (id, user_id, username, text, status, created_at, media, sequence_number) VALUES (?, ?, ?, ?, 'pending', ?, ?, (SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM post))",
            postId,
            userId,
            username || 'unknown',
            text,
            Date.now(),
            mediaJson
        )
    }

    async addMediaGroupItem(item: {
        groupId: string
        type: string
        fileId: string
        caption: string | null
        captionAbove: boolean
        chatId: number
        messageId: number
        userId: number
        username: string
    }): Promise<void> {
        await this.run(
            `INSERT INTO media_group_items (group_id, type, file_id, caption, caption_above, chat_id, message_id, user_id, username, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            item.groupId,
            item.type,
            item.fileId,
            item.caption,
            item.captionAbove ? 1 : 0,
            item.chatId,
            item.messageId,
            item.userId,
            item.username,
            Date.now()
        )
    }

    async getMediaGroupItems(groupId: string): Promise<
        {
            type: string
            file_id: string
            caption: string | null
            caption_above: number
            chat_id: number
            message_id: number
            user_id: number
            username: string
        }[]
    > {
        return this.all(
            'SELECT type, file_id, caption, caption_above, chat_id, message_id, user_id, username FROM media_group_items WHERE group_id = ? ORDER BY seq',
            groupId
        )
    }

    async getMediaGroupLastAt(groupId: string): Promise<number | null> {
        const rows = await this.all<{ t: number | null }>(
            'SELECT MAX(created_at) AS t FROM media_group_items WHERE group_id = ?',
            groupId
        )
        return rows[0]?.t ?? null
    }

    async deleteMediaGroupItems(groupId: string): Promise<void> {
        await this.run('DELETE FROM media_group_items WHERE group_id = ?', groupId)
    }

    async updatePostAdminMsg(postId: string, msgId: number): Promise<void> {
        await this.run('UPDATE post SET admin_msg_id = ? WHERE id = ?', msgId, postId)
    }

    async updatePostStatus(postId: string, status: PostStatus, publishAtMs?: number): Promise<void> {
        if (publishAtMs === undefined) {
            await this.run('UPDATE post SET status = ? WHERE id = ?', status, postId)
        } else {
            await this.run(
                'UPDATE post SET status = ?, publish_at = ? WHERE id = ?',
                status,
                publishAtMs,
                postId
            )
        }
    }

    async addVote(postId: string, adminId: number, adminUsername: string | null, val: number): Promise<void> {
        await this.run(
            `INSERT INTO vote (post_id, admin_id, admin_username, vote) VALUES (?, ?, ?, ?)
             ON CONFLICT (post_id, admin_id)
             DO UPDATE SET vote = excluded.vote, admin_username = excluded.admin_username`,
            postId,
            adminId,
            adminUsername ?? 'unknown',
            val
        )
    }

    async getPostVotes(postId: string): Promise<VoteRow[]> {
        return this.all<VoteRow>(
            'SELECT post_id, admin_id, admin_username, vote FROM vote WHERE post_id = ?',
            postId
        )
    }

    async getVotesForPosts(postIds: string[]): Promise<(VoteRow & { post_id: string })[]> {
        if (postIds.length === 0) return []
        const placeholders = postIds.map(() => '?').join(',')
        return this.all<VoteRow & { post_id: string }>(
            `SELECT post_id, admin_id, admin_username, vote FROM vote WHERE post_id IN (${placeholders})`,
            ...postIds
        )
    }

    async getPendingPostsWithVotes(): Promise<{ post: PostRow; votes: VoteRow[] }[]> {
        interface PendingJoinRow extends PostRow {
            vote: number | null
            admin_id_v: number | null
            admin_username_v: string | null
        }
        const rows = await this.all<PendingJoinRow>(
            `SELECT p.*, v.vote AS vote, v.admin_id AS admin_id_v, v.admin_username AS admin_username_v
             FROM post p LEFT JOIN vote v ON v.post_id = p.id
             WHERE p.status = 'pending' ORDER BY p.created_at ASC`
        )

        const grouped = new Map<string, { post: PostRow; votes: VoteRow[] }>()
        for (const r of rows) {
            let entry = grouped.get(r.id)
            if (!entry) {
                const { vote: _v, admin_id_v: _a, admin_username_v: _u, ...post } = r
                entry = { post: post as PostRow, votes: [] }
                grouped.set(r.id, entry)
            }
            if (r.vote !== null && r.admin_id_v !== null) {
                entry.votes.push({
                    post_id: r.id,
                    admin_id: r.admin_id_v,
                    admin_username: r.admin_username_v,
                    vote: r.vote,
                })
            }
        }
        return [...grouped.values()]
    }

    async isBlocked(userId: number): Promise<boolean> {
        const rows = await this.all<{ id: number }>('SELECT id FROM blocked_user WHERE id = ?', userId)
        return rows.length > 0
    }

    async blockUser(userId: number): Promise<void> {
        await this.run('INSERT INTO blocked_user (id) VALUES (?) ON CONFLICT DO NOTHING', userId)
    }

    async getLatestPublishedMs(): Promise<number | null> {
        const rows = await this.all<{ t: number | null }>(
            "SELECT MAX(publish_at) AS t FROM post WHERE status = 'published'"
        )
        return rows[0]?.t ?? null
    }

    async getScheduledQueue(): Promise<PostRow[]> {
        return this.all<PostRow>(
            'SELECT id, username, text, publish_at, created_at, admin_msg_id, sequence_number, user_id, status FROM post WHERE status = \'scheduled\' ORDER BY publish_at ASC'
        )
    }

    async getPostsToPublish(nowMs: number): Promise<Pick<PostRow, 'id' | 'text' | 'user_id' | 'admin_msg_id' | 'media'>[]> {
        return this.all<Pick<PostRow, 'id' | 'text' | 'user_id' | 'admin_msg_id' | 'media'>>(
            "SELECT id, text, user_id, admin_msg_id, media FROM post WHERE status = 'scheduled' AND publish_at <= ?",
            nowMs
        )
    }

    async getConfig<K extends keyof ConfigMap>(key: K): Promise<ConfigMap[K] | null> {
        const rows = await this.all<{ value: string }>('SELECT value FROM config WHERE key = ?', key)
        return rows[0] ? (JSON.parse(rows[0].value) as ConfigMap[K]) : null
    }

    async setConfig<K extends keyof ConfigMap>(key: K, value: ConfigMap[K]): Promise<void> {
        await this.run(
            'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            key,
            JSON.stringify(value)
        )
    }

    async getPost(postId: string): Promise<PostRow | null> {
        const rows = await this.all<PostRow>('SELECT * FROM post WHERE id = ?', postId)
        return rows[0] ?? null
    }

    async getPostByAdminMsg(adminMsgId: number): Promise<PostRow | null> {
        const rows = await this.all<PostRow>(
            'SELECT * FROM post WHERE admin_msg_id = ? LIMIT 1',
            adminMsgId
        )
        return rows[0] ?? null
    }

    async getPostsWithMissingAdminMsg(): Promise<PostRow[]> {
        return this.all<PostRow>("SELECT * FROM post WHERE admin_msg_id IS NULL AND status IN ('pending','scheduled')")
    }

    async updatePostText(postId: string, newText: string): Promise<void> {
        await this.run('UPDATE post SET text = ? WHERE id = ?', newText, postId)
    }

    async updatePostMedia(postId: string, mediaJson: string): Promise<void> {
        await this.run('UPDATE post SET media = ? WHERE id = ?', mediaJson, postId)
    }

    async addDialogue(userMsgId: number, adminMsgId: number, postId: string): Promise<void> {
        await this.run(
            'INSERT OR REPLACE INTO dialogue (user_msg_id, admin_msg_id, post_id) VALUES (?, ?, ?)',
            userMsgId,
            adminMsgId,
            postId
        )
    }

    async getDialogue(userMsgId: number): Promise<DialogueRow | null> {
        const rows = await this.all<DialogueRow>(
            'SELECT user_msg_id, admin_msg_id, post_id FROM dialogue WHERE user_msg_id = ?',
            userMsgId
        )
        return rows[0] ?? null
    }

    async updatePostsBatch(updates: QueueUpdate[]): Promise<void> {
        if (updates.length === 0) return
        const stmts = updates.map((u) =>
            this.d1.prepare("UPDATE post SET publish_at = ?, status = 'scheduled' WHERE id = ?").bind(u.publish_at, u.id)
        )
        for (let i = 0; i < stmts.length; i += 50) {
            await this.d1.batch(stmts.slice(i, i + 50))
        }
    }
}
