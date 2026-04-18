import React, {useEffect, useState, useMemo} from 'react'
import {PostCard, EditModal} from './components.jsx'

const API_BASE_URL = new URLSearchParams(window.location.search).get('api');
const LIMIT = 20;

const App = () => {
    const [allPosts, setAllPosts] = useState([]); // Центральное хранилище
    const [role, setRole] = useState('loading');
    const [tab, setTab] = useState('pending'); // Админ: pending, scheduled, published, rejected, user_view
    const [userTab, setUserTab] = useState('active'); // Юзер: active, archived
    const [loading, setLoading] = useState(false);
    const [loadedTabs, setLoadedTabs] = useState(new Set()); // Кэш вкладок
    const [editingPost, setEditingPost] = useState(null);

    const tg = window.Telegram?.WebApp;
    const authHeader = tg?.initData || "";

    // Интеграция темы Telegram
    useEffect(() => {
        if (tg) {
            tg.ready(); tg.expand();
            const p = tg.themeParams;
            const root = document.documentElement;
            if (p.bg_color) root.style.setProperty('--tg-bg', p.bg_color);
            if (p.text_color) root.style.setProperty('--tg-text', p.text_color);
            if (p.hint_color) root.style.setProperty('--tg-hint', p.hint_color);
            if (p.button_color) root.style.setProperty('--tg-button', p.button_color);
            if (p.secondary_bg_color) root.style.setProperty('--tg-secondary-bg', p.secondary_bg_color);
        }
    }, [tg]);

    // Метод получения одного поста для синхронизации после экшена
    const syncPost = async (postId) => {
        try {
            const res = await fetch(`${API_BASE_URL}?method=get_single_post&post_id=${postId}`, {
                headers: { 'X-Tg-Data': authHeader }
            });
            if (res.ok) {
                const updatedPost = await res.json();
                setAllPosts(prev => prev.map(p => p.id === postId ? updatedPost : p));
            }
        } catch (e) { console.error("Sync failed:", e); }
    };

    // Загрузка списка постов
    const load = async (isRefresh = false) => {
        const currentModeKey = (role === 'user' || tab === 'user_view') ? `user_${userTab}` : tab;
        if (loadedTabs.has(currentModeKey) && !isRefresh) return;

        setLoading(true);
        try {
            const isUserMode = (role === 'user' || tab === 'user_view');
            const method = isUserMode ? 'get_my_posts' : 'get_posts';
            const url = `${API_BASE_URL}?method=${method}${!isUserMode ? `&status=${tab}` : ''}&limit=${LIMIT}`;

            const res = await fetch(url, { headers: { 'X-Tg-Data': authHeader } });
            if (res.status === 401) { setRole('unauthorized'); return; }

            const json = await res.json();
            const incoming = json.posts || json;

            setAllPosts(prev => {
                const incomingIds = new Set(incoming.map(p => p.id));
                const filteredPrev = prev.filter(p => !incomingIds.has(p.id));
                return [...filteredPrev, ...incoming];
            });

            if (json.role) setRole(json.role);
            if (!isRefresh) setLoadedTabs(prev => new Set(prev).add(currentModeKey));
        } catch (e) { console.error(e); }
        setLoading(false);
    };

    useEffect(() => { load(); }, [tab, userTab, role]);

    const handleAction = async (postId, action, extra = {}) => {
        if (action === 'editing') {
            setEditingPost(allPosts.find(p => p.id === postId));
            return;
        }

        // Оптимистичное обновление (локально)
        try {
            const res = await fetch(`${API_BASE_URL}?method=action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Tg-Data': authHeader },
                body: JSON.stringify({ post_id: postId, action, ...extra })
            });

            if (res.ok) {
                // Если успешно — подтягиваем свежие данные этого поста (рейтинг, время)
                await syncPost(postId);
            } else { alert("ОШИБКА БЭКЕНДА"); }
        } catch { alert("СЕТЕВАЯ ОШИБКА"); }
    };

    // Фильтрация данных для рендера
    const displayPosts = useMemo(() => {
        return allPosts.filter(p => {
            if (role === 'user' || tab === 'user_view') {
                if (userTab === 'active') return p.status !== 'published' && p.status !== 'rejected';
                return p.status === 'published' || p.status === 'rejected';
            }
            return p.status === tab;
        }).sort((a, b) => (b.publish_at || b.created_at) - (a.publish_at || a.created_at));
    }, [allPosts, tab, userTab, role]);

    if (role === 'loading') return <div className="flex min-h-screen items-center justify-center font-black text-[var(--tg-hint)] animate-pulse uppercase">Загрузка...</div>;
    if (role === 'unauthorized') return <div className="p-20 text-center text-red-500 font-black uppercase">Ошибка авторизации</div>;

    return (
        <div className="max-w-5xl mx-auto p-4 pb-24 min-h-screen bg-[var(--tg-bg)] font-sans">
            <header className="flex justify-between items-center mb-6">
                <h1 className="font-black text-xl uppercase italic tracking-tighter text-[var(--tg-text)]">
                    {role === 'admin' ? (tab === 'user_view' ? 'VIEW AS USER' : 'ADMIN HUB') : 'МОИ ПОСТЫ'}
                </h1>
                <button onClick={() => load(true)} className={`${loading ? 'animate-spin' : ''} text-[var(--tg-button)] p-2`}>
                    <i className="fa-solid fa-arrows-rotate text-lg"></i>
                </button>
            </header>

            {role === 'admin' && (
                <div className="flex gap-1 mb-8 bg-[var(--tg-secondary-bg)] p-1 rounded-2xl overflow-x-auto no-scrollbar shadow-inner">
                    {['pending', 'scheduled', 'published', 'rejected', 'user_view'].map(s => (
                        <button key={s} onClick={() => setTab(s)}
                            className={`flex-1 min-w-[85px] py-2 text-[9px] font-black uppercase rounded-xl transition-all ${tab === s ? 'bg-[var(--tg-bg)] shadow-sm text-[var(--tg-button)]' : 'text-[var(--tg-hint)]'}`}>
                            {s === 'pending' ? 'Новые' : s === 'scheduled' ? 'Очередь' : s === 'published' ? 'Архив' : s === 'rejected' ? 'Отказ' : 'Как юзер'}
                        </button>
                    ))}
                </div>
            )}

            {(role === 'user' || tab === 'user_view') && (
                <div className="flex gap-1 mb-6 bg-[var(--tg-secondary-bg)] p-1 rounded-2xl max-w-md mx-auto shadow-inner border border-[var(--tg-hint)]/5">
                    <button onClick={() => setUserTab('active')} className={`flex-1 py-2 text-[10px] font-black uppercase rounded-xl transition-all ${userTab === 'active' ? 'bg-[var(--tg-bg)] shadow-sm text-[var(--tg-button)]' : 'text-[var(--tg-hint)]'}`}>Активные</button>
                    <button onClick={() => setUserTab('published')} className={`flex-1 py-2 text-[10px] font-black uppercase rounded-xl transition-all ${userTab === 'published' ? 'bg-[var(--tg-bg)] shadow-sm text-[var(--tg-button)]' : 'text-[var(--tg-hint)]'}`}>Архив</button>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {displayPosts.map(p => (
                    <PostCard key={p.id} post={p} onAction={handleAction} isUserView={role === 'user' || tab === 'user_view'} />
                ))}
            </div>

            {displayPosts.length === 0 && !loading && (
                <div className="text-center py-20 bg-[var(--tg-secondary-bg)] rounded-3xl border-2 border-dashed border-[var(--tg-hint)]/10 text-[var(--tg-hint)] font-black uppercase tracking-widest text-xs opacity-50">Пусто</div>
            )}

            {editingPost && (
                <EditModal post={editingPost} onClose={() => setEditingPost(null)} onSave={(text) => handleAction(editingPost.id, 'edit', { text })} />
            )}
        </div>
    );
};

export default App;