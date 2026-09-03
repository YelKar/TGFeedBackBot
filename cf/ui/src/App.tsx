import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { EditModal, PostCard } from './components'
import { fetchPosts, fetchSinglePost, sendAction } from './api'
import type { ActionId, AdminTab, Post, Role, UserTab } from './types'

const PAGE_SIZE = 20

function App(): ReactNode {
    const [allPosts, setAllPosts] = useState<Post[]>([])
    const [role, setRole] = useState<Role>('loading')
    const [tab, setTab] = useState<AdminTab>('pending')
    const [userTab, setUserTab] = useState<UserTab>('active')
    const [loading, setLoading] = useState(false)
    const [cursor, setCursor] = useState<number | null>(null)
    const [exhausted, setExhausted] = useState(false)
    const [editingPost, setEditingPost] = useState<Post | null>(null)

    const tg = window.Telegram?.WebApp

    // Интеграция темы Telegram
    useEffect(() => {
        if (!tg) return
        tg.ready()
        tg.expand()
        const p = tg.themeParams
        const root = document.documentElement
        if (p.bg_color) root.style.setProperty('--tg-bg', p.bg_color)
        if (p.text_color) root.style.setProperty('--tg-text', p.text_color)
        if (p.hint_color) root.style.setProperty('--tg-hint', p.hint_color)
        if (p.button_color) root.style.setProperty('--tg-button', p.button_color)
        if (p.secondary_bg_color) root.style.setProperty('--tg-secondary-bg', p.secondary_bg_color)
    }, [tg])

    async function syncPost(postId: string): Promise<void> {
        const updatedPost = await fetchSinglePost(postId)
        if (updatedPost) {
            setAllPosts((prev) => prev.map((p) => (p.id === postId ? updatedPost : p)))
        }
    }

    function isUserMode(): boolean {
        return role === 'user' || tab === 'user_view'
    }

    /**
     * fresh=true — первая страница вкладки (курсор сбрасывается),
     * fresh=false — догрузка следующей страницы по курсору.
     */
    async function load(fresh: boolean): Promise<void> {
        if (loading || role === 'loading' || role === 'unauthorized') return
        if (!fresh && (exhausted || cursor === null)) return

        setLoading(true)
        try {
            const mode = isUserMode()
            const method = mode ? 'get_my_posts' : 'get_posts'
            const { posts: incoming, role: newRole } = await fetchPosts(
                method,
                mode ? undefined : tab,
                fresh ? null : cursor
            )

            setAllPosts((prev) => {
                const ids = new Set(incoming.map((p) => p.id))
                return fresh ? [...prev.filter((p) => !ids.has(p.id)), ...incoming] : [...prev.filter((p) => !ids.has(p.id)), ...incoming]
            })

            setRole(newRole)
            if (incoming.length < PAGE_SIZE) setExhausted(true)
            if (incoming.length > 0) {
                const oldest = Math.min(...incoming.map((p) => p.created_at))
                setCursor((prevCursor) => (fresh ? oldest : Math.min(prevCursor ?? Infinity, oldest)))
            }
        } catch (e) {
            if (e instanceof Error && e.message === 'unauthorized') setRole('unauthorized')
            else console.error(e)
        }
        setLoading(false)
    }

    useEffect(() => {
        setExhausted(false)
        setCursor(null)
        void load(true)
    }, [tab, userTab, role])

    useEffect(() => {
        const onScroll = (): void => {
            if (loading || exhausted) return
            const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 800
            if (nearBottom) void load(false)
        }
        window.addEventListener('scroll', onScroll)
        return () => window.removeEventListener('scroll', onScroll)
    })

    async function handleAction(
        postId: string,
        action: ActionId | 'editing',
        extra: Record<string, unknown> = {}
    ): Promise<void> {
        if (action === 'editing') {
            setEditingPost(allPosts.find((p) => p.id === postId) ?? null)
            return
        }

        const ok = await sendAction(postId, action, extra)
        if (ok) await syncPost(postId)
        else alert('ОШИБКА БЭКЕНДА')
    }

    const displayPosts = useMemo(() => {
        return allPosts
            .filter((p) => {
                if (role === 'user' || tab === 'user_view') {
                    if (userTab === 'active') return p.status !== 'published' && p.status !== 'rejected'
                    return p.status === 'published' || p.status === 'rejected'
                }
                return p.status === tab
            })
            .sort((a, b) => (b.publish_at ?? b.created_at) - (a.publish_at ?? a.created_at))
    }, [allPosts, tab, userTab, role])

    if (role === 'loading') {
        return (
            <div className="flex min-h-screen items-center justify-center font-black text-[var(--tg-hint)] animate-pulse uppercase">
                Загрузка...
            </div>
        )
    }
    if (role === 'unauthorized') {
        return <div className="p-20 text-center text-red-500 font-black uppercase">Ошибка авторизации</div>
    }

    const refreshButton = (
        <button onClick={() => void load(true)} className={`${loading ? 'animate-spin' : ''} text-[var(--tg-button)] p-2`}>
            <i className="fa-solid fa-arrows-rotate text-lg"></i>
        </button>
    )

    const adminTabs: AdminTab[] = ['pending', 'scheduled', 'published', 'rejected', 'user_view']
    const showUserTabs = role === 'user' || tab === 'user_view'

    return (
        <div className="max-w-5xl mx-auto p-4 pb-24 min-h-screen bg-[var(--tg-bg)] font-sans">
            <header className="flex justify-between items-center mb-6">
                <h1 className="font-black text-xl uppercase italic tracking-tighter text-[var(--tg-text)]">
                    {role === 'admin' ? (tab === 'user_view' ? 'VIEW AS USER' : 'ADMIN HUB') : 'МОИ ПОСТЫ'}
                </h1>
                {refreshButton}
            </header>

            {role === 'admin' && (
                <div className="flex gap-1 mb-8 bg-[var(--tg-secondary-bg)] p-1 rounded-2xl overflow-x-auto no-scrollbar shadow-inner">
                    {adminTabs.map((s) => (
                        <button
                            key={s}
                            onClick={() => setTab(s)}
                            className={`flex-1 min-w-[85px] py-2 text-[9px] font-black uppercase rounded-xl transition-all ${
                                tab === s ? 'bg-[var(--tg-bg)] shadow-sm text-[var(--tg-button)]' : 'text-[var(--tg-hint)]'
                            }`}
                        >
                            {s === 'pending' ? 'Новые' : s === 'scheduled' ? 'Очередь' : s === 'published' ? 'Архив' : s === 'rejected' ? 'Отказ' : 'Как юзер'}
                        </button>
                    ))}
                </div>
            )}

            {showUserTabs && (
                <div className="flex gap-1 mb-6 bg-[var(--tg-secondary-bg)] p-1 rounded-2xl max-w-md mx-auto shadow-inner border border-[var(--tg-hint)]/5">
                    <button
                        onClick={() => setUserTab('active')}
                        className={`flex-1 py-2 text-[10px] font-black uppercase rounded-xl transition-all ${
                            userTab === 'active' ? 'bg-[var(--tg-bg)] shadow-sm text-[var(--tg-button)]' : 'text-[var(--tg-hint)]'
                        }`}
                    >
                        Активные
                    </button>
                    <button
                        onClick={() => setUserTab('published')}
                        className={`flex-1 py-2 text-[10px] font-black uppercase rounded-xl transition-all ${
                            userTab === 'published' ? 'bg-[var(--tg-bg)] shadow-sm text-[var(--tg-button)]' : 'text-[var(--tg-hint)]'
                        }`}
                    >
                        Архив
                    </button>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {displayPosts.map((p) => (
                    <PostCard key={p.id} post={p} onAction={handleAction} isUserView={showUserTabs} />
                ))}
            </div>

            {displayPosts.length === 0 && !loading && (
                <div className="text-center py-20 bg-[var(--tg-secondary-bg)] rounded-3xl border-2 border-dashed border-[var(--tg-hint)]/10 text-[var(--tg-hint)] font-black uppercase tracking-widest text-xs opacity-50">
                    Пусто
                </div>
            )}

            {!exhausted && displayPosts.length > 0 && (
                <div className="flex justify-center py-6">
                    {loading ? (
                        <i className="fa-solid fa-circle-notch animate-spin text-[var(--tg-hint)]"></i>
                    ) : (
                        <button
                            onClick={() => void load(false)}
                            className="text-[10px] font-black uppercase tracking-widest text-[var(--tg-hint)] px-6 py-3"
                        >
                            Показать ещё
                        </button>
                    )}
                </div>
            )}

            {exhausted && displayPosts.length > 0 && (
                <div className="text-center pb-4 text-[9px] uppercase tracking-widest text-[var(--tg-hint)] opacity-40">
                    Это всё
                </div>
            )}

            {editingPost && (
                <EditModal
                    post={editingPost}
                    onClose={() => setEditingPost(null)}
                    onSave={(text) => void handleAction(editingPost.id, 'edit', { text })}
                />
            )}
        </div>
    )
}

export default App
