/** SSL Labs grades from best to worst. T (trust issues) and M (name mismatch) rank below F. */
export const GRADE_ORDER = ['A+', 'A', 'A-', 'B', 'C', 'D', 'E', 'F', 'T', 'M'] as const;

export type Grade = (typeof GRADE_ORDER)[number];

export function isGrade(value: unknown): value is Grade {
	return typeof value === 'string' && (GRADE_ORDER as readonly string[]).includes(value);
}

/** Lower rank = better grade. Unknown grades rank as undefined. */
export function gradeRank(grade: unknown): number | undefined {
	return isGrade(grade) ? GRADE_ORDER.indexOf(grade) : undefined;
}

/** Negative when `a` is better than `b`, positive when worse, 0 when equal. Unknown grades sort last. */
export function compareGrades(a: unknown, b: unknown): number {
	const ra = gradeRank(a) ?? GRADE_ORDER.length;
	const rb = gradeRank(b) ?? GRADE_ORDER.length;
	return ra - rb;
}

function pick(grades: unknown[], worst: boolean): Grade | null {
	const known = grades.filter(isGrade);
	if (!known.length) return null;
	return known.reduce((acc, g) =>
		(worst ? compareGrades(g, acc) > 0 : compareGrades(g, acc) < 0) ? g : acc,
	);
}

/** The worst known grade, ignoring missing/unknown values; null when none. */
export function worstGrade(grades: unknown[]): Grade | null {
	return pick(grades, true);
}

/** The best known grade, ignoring missing/unknown values; null when none. */
export function bestGrade(grades: unknown[]): Grade | null {
	return pick(grades, false);
}

/** True when `grade` is known and strictly worse than `threshold`. */
export function isWorseThan(grade: unknown, threshold: Grade): boolean {
	return isGrade(grade) && compareGrades(grade, threshold) > 0;
}
