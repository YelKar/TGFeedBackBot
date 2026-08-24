import { describe, expect, it } from 'vitest'
import { getRatingStatus, robustMean, THRESHOLD } from '../src/rating'

describe('robustMean', () => {
    it('пустой список → 0', () => {
        expect(robustMean([])).toBe(0)
    })

    it('одинаковые оценки → точное значение', () => {
        expect(robustMean([3, 3, 3])).toBe(3)
    })

    it('выброс отбрасывается', () => {
        // простое среднее дало бы 2.0
        expect(robustMean([1, 1, 1, 1, 1, 5])).toBeLessThan(1.5)
    })
})

describe('getRatingStatus', () => {
    it('прогноз согласован по границам', () => {
        const res = getRatingStatus([5, 2], 10)
        expect(res.min_estimation).toBeLessThanOrEqual(res.estimation)
        expect(res.estimation).toBeLessThanOrEqual(res.max_estimation)
        expect(res.is_final).toBe(false)
    })

    it('все проголосовали — финал и одобрение', () => {
        const res = getRatingStatus([4, 5], 2)
        expect(res.is_final).toBe(true)
        expect(res.estimation).toBeGreaterThanOrEqual(THRESHOLD)
        expect(res.is_guaranteed_approved).toBe(true)
    })

    it('единогласный отказ', () => {
        const res = getRatingStatus([1, 1], 2)
        expect(res.is_final).toBe(true)
        expect(res.estimation).toBeLessThan(THRESHOLD)
        expect(res.is_guaranteed_rejected).toBe(true)
    })

    it('чем больше непроголосовавших, тем шире прогноз', () => {
        const narrow = getRatingStatus([4, 4], 3)
        const wide = getRatingStatus([4, 4], 50)
        expect(wide.max_estimation - wide.min_estimation).toBeGreaterThan(
            narrow.max_estimation - narrow.min_estimation
        )
    })
})
