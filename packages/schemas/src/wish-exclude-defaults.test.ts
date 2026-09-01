import { describe, expect, it } from 'vitest';

import { PlannerProfileSchema } from './planner-profile.js';

describe('wish_and_exclude independent lists', () => {
  it('defaults the untouched side when only exclude was filled', () => {
    const parsed = PlannerProfileSchema.parse({
      interests: { wish_and_exclude: { exclude: ['crowded-store'] } },
    });

    expect(parsed.interests?.wish_and_exclude).toEqual({
      wish: [],
      exclude: ['crowded-store'],
    });
  });

  it('defaults the untouched side when only wish was filled', () => {
    const parsed = PlannerProfileSchema.parse({
      interests: { wish_and_exclude: { wish: ['quiet-cafe'] } },
    });

    expect(parsed.interests?.wish_and_exclude).toEqual({
      wish: ['quiet-cafe'],
      exclude: [],
    });
  });
});
