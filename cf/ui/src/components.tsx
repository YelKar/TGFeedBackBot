import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ActionId, Analytics, Post } from './types'

interface RatingDisplayProps {
    analytics: Analytics | undefined
    hideForecast?: boolean
}

export function RatingDisplay({ analytics, hideForecast = false }: RatingDisplayProps): ReactNode {
    if (!analytics) return null
    const { res, votes_list: votesList } = analytics

    return (
        <div className="mb-4 p-3 bg-[var(--tg-secondary-bg)] rounded-xl border border-[var(--tg-hint)]/10 text-[var(--tg-text)]">
            <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] font-black text-[var(--tg-hint)] uppercase tracking-tighter">Рейтинг</span>
                <span className="text-sm font-black text-[var(--tg-button)]">{res.estimation}</span>
            </div>
            {!hideForecast && (
                <>
                    <div className="text-[9px] text-[var(--tg-hint)] mb-2 truncate opacity-60">
                        {votesList || 'Нет голосов'}
                    </div>
                    {!res.is_final && (
                        <div className="text-[9px] text-[var(--tg-hint)] font-bold uppercase pt-2 border-t border-[var(--tg-hint)]/20">
                            Прогноз: {res.min_estimation} — {res.max_estimation}
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

const STATUS_LABELS: Record<Post['status'], string> = {
    pending: 'Ожидает оценки',
    scheduled: 'Запланирован',
    published: 'Опубликован',
    rejected: 'Отклонён',
}

interface PostCardProps {
    post: Post
    onAction: (postId: string, action: ActionId | 'editing', extra?: Record<string, unknown>) => void
    isUserView: boolean
}

export function PostCard({ post, onAction, isUserView }: PostCardProps): ReactNode {
    return (
        <div className="bg-[var(--tg-bg)] p-5 rounded-3xl shadow-sm border border-[var(--tg-hint)]/20 flex flex-col justify-between transition-all">
            <div>
                <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-[var(--tg-button)] uppercase tracking-widest">@{post.username || 'user'}</span>
                        {post.media_count > 0 && (
                            <span className="text-[10px] text-[var(--tg-hint)]">📷 {post.media_count}</span>
                        )}
                    </div>
                    {!isUserView && <EllipsisMenu post={post} onAction={onAction} />}
                </div>

                <div
                    className="text-[var(--tg-text)] text-sm mb-4 leading-relaxed line-clamp-6"
                    dangerouslySetInnerHTML={{ __html: post.text }}
                />

                <RatingDisplay analytics={post.analytics} hideForecast={isUserView} />

                {!isUserView && post.status !== 'published' && (
                    <div className="flex gap-1 mb-4">
                        {[1, 2, 3, 4, 5].map((v) => (
                            <button
                                key={v}
                                onClick={() => onAction(post.id, 'vote', { val: v })}
                                className="flex-1 py-2 text-[10px] font-black border border-[var(--tg-hint)]/20 rounded-lg hover:bg-[var(--tg-button)] hover:text-white transition-all"
                            >
                                {v}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center">
                    <span
                        className={`text-[10px] font-black px-3 py-1 rounded-full uppercase ${
                            post.status === 'published'
                                ? 'bg-green-500/10 text-green-500'
                                : post.status === 'scheduled'
                                  ? 'bg-blue-500/10 text-blue-500'
                                  : post.status === 'rejected'
                                    ? 'bg-red-500/10 text-red-500'
                                    : 'bg-[var(--tg-hint)]/10 text-[var(--tg-hint)]'
                        }`}
                    >
                        {STATUS_LABELS[post.status]}
                    </span>

                    {post.publish_at && ['scheduled', 'published'].includes(post.status) && (
                        <div className="text-[9px] font-black text-[var(--tg-hint)] uppercase flex items-center gap-1">
                            <i className="fa-regular fa-clock"></i>
                            {new Date(post.publish_at * 1000).toLocaleString('ru-RU', {
                                hour: '2-digit',
                                minute: '2-digit',
                                day: '2-digit',
                                month: '2-digit',
                            })}
                        </div>
                    )}
                </div>

                {!isUserView && ['pending', 'scheduled'].includes(post.status) && (
                    <button
                        onClick={() => onAction(post.id, 'reject')}
                        className="w-full py-2 bg-[var(--tg-secondary-bg)] text-[var(--tg-hint)] text-[10px] font-black uppercase rounded-xl hover:text-red-500 transition-all mt-2"
                    >
                        Отклонить
                    </button>
                )}
            </div>
        </div>
    )
}

interface EllipsisMenuProps {
    post: Post
    onAction: (postId: string, action: ActionId | 'editing') => void
}

export function EllipsisMenu({ post, onAction }: EllipsisMenuProps): ReactNode {
    const [isOpen, setIsOpen] = useState(false)
    const actions: { id: ActionId; label: string; icon: string; show: boolean }[] = [
        { id: 'schedule', label: 'В очередь (форс)', icon: 'fa-clock', show: post.status === 'pending' },
        { id: 'publish_now', label: 'Опубликовать сейчас', icon: 'fa-paper-plane', show: post.status !== 'published' },
        { id: 'edit', label: 'Редактировать', icon: 'fa-pen', show: true },
        { id: 'block', label: 'Забанить автора', icon: 'fa-user-slash', show: true },
        { id: 'delete', label: 'Удалить из БД', icon: 'fa-trash', show: true },
    ]

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="p-1 text-[var(--tg-hint)] opacity-40 hover:opacity-100 transition-opacity"
            >
                <i className="fa-solid fa-ellipsis"></i>
            </button>
            {isOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)}></div>
                    <div className="absolute right-0 mt-2 w-56 bg-[var(--tg-secondary-bg)] border border-[var(--tg-hint)]/20 rounded-2xl shadow-2xl z-50 overflow-hidden shadow-black/20">
                        {actions
                            .filter((a) => a.show)
                            .map((a) => (
                                <button
                                    key={a.id}
                                    onClick={() => {
                                        onAction(post.id, a.id)
                                        setIsOpen(false)
                                    }}
                                    className={`w-full text-left px-4 py-3 text-[10px] font-black uppercase hover:bg-[var(--tg-bg)] flex items-center gap-3 transition-colors ${
                                        a.id === 'block' || a.id === 'delete' ? 'text-red-500' : 'text-[var(--tg-text)]'
                                    }`}
                                >
                                    <i className={`fa-solid ${a.icon} w-4 text-center`}></i> {a.label}
                                </button>
                            ))}
                    </div>
                </>
            )}
        </div>
    )
}

interface EditModalProps {
    post: Post
    onClose: () => void
    onSave: (text: string) => void
}

export function EditModal({ post, onClose, onSave }: EditModalProps): ReactNode {
    const [text, setText] = useState(post.text)
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg bg-[var(--tg-bg)] rounded-3xl shadow-2xl overflow-hidden">
                <div className="p-6 border-b border-[var(--tg-hint)]/10 flex justify-between items-center">
                    <h2 className="font-black uppercase text-[10px] text-[var(--tg-hint)]">Редактирование</h2>
                    <button onClick={onClose} className="text-[var(--tg-hint)]">
                        <i className="fa-solid fa-xmark text-lg"></i>
                    </button>
                </div>
                <div className="p-6">
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        className="w-full h-64 bg-[var(--tg-secondary-bg)] text-[var(--tg-text)] p-4 rounded-2xl border border-[var(--tg-hint)]/20 focus:outline-none focus:border-[var(--tg-button)] text-sm leading-relaxed"
                    />
                </div>
                <div className="p-6 bg-[var(--tg-secondary-bg)] flex gap-3">
                    <button onClick={onClose} className="flex-1 py-3 font-black uppercase text-[10px] text-[var(--tg-hint)]">
                        Отмена
                    </button>
                    <button
                        onClick={() => {
                            onSave(text)
                            onClose()
                        }}
                        className="flex-[2] py-3 bg-[var(--tg-button)] text-white rounded-xl font-black uppercase text-[10px]"
                    >
                        Сохранить
                    </button>
                </div>
            </div>
        </div>
    )
}
