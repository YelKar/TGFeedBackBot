from loguru import logger
import sys

def setup_logger():
    logger.remove()

    logger.add(
        sys.stdout,
        level="INFO",
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> "
               "[<level>{level}</level>] "
               "<cyan>{name}</cyan>: <level>{message}</level>",
        backtrace=False,
        diagnose=False,
    )

    logger.add(
        "bot.log",
        level="INFO",
        format="{time:YYYY-MM-DD HH:mm:ss} [{level}] {name}: {message}",
        rotation="10 MB",
        retention="7 days",
        compression="zip",
        enqueue=True,
    )
