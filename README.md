# TGFeedBackBot
## Развёртывание
### 1. Клонируем репозиторий
```bash
git clone https://github.com/YelKar/TGFeedBackBot.git
```

### 2. Настройка среды
#### 2.1 Создаём и активируем виртуальное окружение
```bash
python -m venv venv
```

##### Linux
```bash
source ./venv/bin/activate
```

##### Windows
```bash
.\venv\Scripts\activate
```

#### 2.2 Установка пакетов
```bash
pip install -r requirements.txt
```

### Создаем .env
```ini
TOKEN=<TELEGRAM_TOKEN>
CHAT_ID=<FEEDBACK_CHAT_ID>
CHANNEL_ID=<CHANNEL_ID>
```

В данный конфигурационный файл указываем:
1) Токен телеграм-бота
2) ID чата, в который бот будет присылать посты на проверку. 
   - Если чат групповой, бот должен иметь в нём роль администратора.
   - Если чат одиночный, Вам нужно первыми начать переписку.
3) ID канала, в котором бот имеет роль админа.

