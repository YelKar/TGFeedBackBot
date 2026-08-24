export const THRESHOLD = 3.5
export const VOTE_BOUNDS: readonly [number, number] = [1, 5]
const K = 0.5

export function robustMean(values: number[], k: number = K, iters = 5): number {
    if (values.length === 0) return 0

    let current = values.reduce((a, b) => a + b, 0) / values.length

    for (let i = 0; i < iters; i++) {
        let sumW = 0
        let sumWx = 0
        for (const x of values) {
            const d = Math.abs(x - current)
            const w = 1 / (1 + (d / k) ** 2)
            sumW += w
            sumWx += w * x
        }
        if (sumW > 0) current = sumWx / sumW
    }

    return current
}

export interface RatingStatus {
    estimation: number
    min_estimation: number
    max_estimation: number
    is_final: boolean
    is_guaranteed_approved: boolean
    is_guaranteed_rejected: boolean
}

export function getRatingStatus(scores: number[], totalAdmins: number): RatingStatus {
    const votedCount = scores.length
    const remainingCount = Math.max(0, totalAdmins - votedCount)

    const estimation = robustMean(scores)

    const minValues = scores.concat(Array(remainingCount).fill(VOTE_BOUNDS[0]))
    const minEstimation = robustMean(minValues)

    const maxValues = scores.concat(Array(remainingCount).fill(VOTE_BOUNDS[1]))
    const maxEstimation = robustMean(maxValues)

    return {
        estimation,
        min_estimation: minEstimation,
        max_estimation: maxEstimation,
        is_final: remainingCount <= 0,
        is_guaranteed_approved: minEstimation >= THRESHOLD,
        is_guaranteed_rejected: maxEstimation < THRESHOLD,
    }
}
