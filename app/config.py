import os

if os.path.exists('.env'):
    from dotenv import load_dotenv
    load_dotenv()

BOT_TOKEN = os.getenv('BOT_TOKEN')
MODERATION_CHAT_ID = os.getenv('MODERATION_CHAT_ID')
CHANNEL_ID = os.getenv('CHANNEL_ID')