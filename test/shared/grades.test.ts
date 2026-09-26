import { describe, expect, it } from 'vitest';
import {
	bestGrade,
	compareGrades,
	GRADE_ORDER,
	gradeRank,
	isWorseThan,
	worstGrade,
} from '../../shared/grades';

describe('grades', () => {
	it('orders A+ > A > A- > B > C > D > E > F > T > M', () => {
		const shuffled = ['M', 'B', 'A+', 'T', 'F', 'A-', 'E', 'A', 'D', 'C'];
		expect([...shuffled].sort(compareGrades)).toEqual([...GRADE_ORDER]);
	});

	it('ranks T and M below F', () => {
		expect(compareGrades('T', 'F')).toBeGreaterThan(0);
		expect(compareGrades('M', 'T')).toBeGreaterThan(0);
		expect(gradeRank('M')).toBe(9);
	});

	it('picks worst and best, ignoring missing and unknown grades', () => {
		expect(worstGrade(['A', undefined, 'B', 'A+', 'Z', null])).toBe('B');
		expect(bestGrade(['A', undefined, 'B', 'A+'])).toBe('A+');
		expect(worstGrade(['A', 'T'])).toBe('T');
		expect(worstGrade(['F', 'M', 'T'])).toBe('M');
		expect(worstGrade([])).toBeNull();
		expect(bestGrade([undefined, 'X'])).toBeNull();
	});

	it('compares against a threshold', () => {
		expect(isWorseThan('B', 'A')).toBe(true);
		expect(isWorseThan('A', 'A')).toBe(false);
		expect(isWorseThan('A+', 'A')).toBe(false);
		expect(isWorseThan('T', 'F')).toBe(true);
		expect(isWorseThan(undefined, 'A')).toBe(false);
	});
});
