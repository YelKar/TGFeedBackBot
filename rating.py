THRESHOLD = 3.5
VOTE_BOUNDS = (1, 5)
K = 0.5


def robust_mean(values: list[float], k: float = K, iters: int = 5) -> float:
    if not values:
        return 0.0

    current = sum(values) / len(values)

    for _ in range(iters):
        sum_w = 0.0
        sum_wx = 0.0

        for x in values:
            d = abs(x - current)
            w = 1.0 / (1.0 + (d / k) ** 2)
            sum_w += w
            sum_wx += w * x

        if sum_w > 0:
            current = sum_wx / sum_w

    return current


def get_rating_status(scores: list[int], total_admins: int):
    """
    Рассчитывает текущую оценку и прогноз на основе списка оценок
    и общего количества админов.
    """
    voted_count = len(scores)
    remaining_count = max(0, total_admins - voted_count)

    estimation = robust_mean(scores)

    min_values = scores + [VOTE_BOUNDS[0]] * remaining_count
    min_estimation = robust_mean(min_values)

    max_values = scores + [VOTE_BOUNDS[1]] * remaining_count
    max_estimation = robust_mean(max_values)

    return {
        "estimation": estimation,
        "min_estimation": min_estimation,
        "max_estimation": max_estimation,
        "is_final": remaining_count <= 0,
        "is_guaranteed_approved": min_estimation >= THRESHOLD,
        "is_guaranteed_rejected": max_estimation < THRESHOLD
    }
