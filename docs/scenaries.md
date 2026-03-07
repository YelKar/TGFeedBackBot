## 1️⃣ Диаграмма сущностей и состояний

### 1.1 Жизненный цикл цитаты

```mermaid
stateDiagram-v2
    [*] --> Pending: пользователь отправил цитату

    Pending --> Approved: админ одобрил
    Pending --> Rejected: админ отклонил

    Rejected --> Archived

    Approved --> Scheduled: создан PublishEvent (auto/scheduled)
    Approved --> Published: ручная публикация

    Scheduled --> Published: publish_event.done

    Published --> [*]
```

**Комментарии:**

* `Quote` не знает о времени публикации
* Время живёт **только в PublishEvent**
* `Archived` — терминальное состояние

---

### 1.2 PublishEvent (события публикации)

```mermaid
stateDiagram-v2
    [*] --> Planned

    Planned --> Done: опубликовано
    Planned --> Cancelled: отменено (сдвиг / ручное вмешательство)

    Done --> [*]
    Cancelled --> [*]
```

Тип события:

* `auto`
* `manual`
* `scheduled`

---

## 2️⃣ Диаграмма планирования (временная логика)

```mermaid
flowchart TD
    A[Начало дня / пересчёт] --> B[Загрузить ScheduleRules]
    B --> C[Загрузить PublishEvents дня]
    C --> D[Построить cooldown-зоны]

    D --> E{Дневной лимит достигнут?}
    E -- Да --> Z[Остановиться]
    E -- Нет --> F[Взять preferred_time]

    F --> G{В границах дня?}
    G -- Нет --> F2[Следующий preferred_time]
    G -- Да --> H{Конфликт с cooldown?}

    H -- Нет --> I[Создать auto PublishEvent]
    H -- Да --> J[Сдвиг времени вперёд]

    J --> K{Можно сдвинуть в пределах дня?}
    K -- Нет --> F2
    K -- Да --> I

    I --> L[Добавить cooldown-зону]
    L --> E
```

---

## 3️⃣ Диаграмма взаимодействия компонентов

```mermaid
sequenceDiagram
    participant User
    participant Bot
    participant CloudFunction
    participant YDB
    participant MiniApp
    participant Channel

    User->>Bot: отправляет цитату
    Bot->>CloudFunction: webhook (new quote)
    CloudFunction->>YDB: save Quote (pending)

    Admin->>MiniApp: открыть очередь
    MiniApp->>CloudFunction: approve quote
    CloudFunction->>YDB: update Quote (approved)

    CloudFunction->>YDB: create PublishEvent (auto/scheduled)

    CloudFunction->>Channel: publish post
    CloudFunction->>YDB: mark PublishEvent done
    CloudFunction->>Bot: notify user
```

---

## 4️⃣ Диаграмма ручного вмешательства админа

```mermaid
sequenceDiagram
    participant Admin
    participant MiniApp
    participant CloudFunction
    participant YDB
    participant Channel

    Admin->>MiniApp: "Опубликовать сейчас"
    MiniApp->>CloudFunction: publish_now(quote_id)

    CloudFunction->>YDB: cancel auto events
    CloudFunction->>YDB: create manual PublishEvent
    CloudFunction->>Channel: publish immediately
    CloudFunction->>YDB: mark done

    CloudFunction->>MiniApp: updated schedule
```

---

## 5️⃣ Как это читается целиком

* **Quote** — контент
* **PublishEvent** — время и факт публикации
* **ScheduleRules** — глобальные ограничения
* **Cooldown-зоны** — защита от конфликтов
* **Mini App** — источник истины для админов
* **Bot** — транспорт и уведомления

---