import { describe, expect, it } from 'vitest';
import { localDate, nextFreeSlots, zonedTimeToUtc } from '../../server/posts/slots.js';

const IST = { times: ['19:00'], timezone: 'Asia/Kolkata' };
const TWICE = { times: ['19:00', '09:00'], timezone: 'Asia/Kolkata' };

describe('zonedTimeToUtc', () => {
  it('converts a wall-clock time in a zone to UTC', () => {
    expect(zonedTimeToUtc('2026-11-06', '19:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-06T13:30:00.000Z');
    expect(zonedTimeToUtc('2026-01-15', '09:00', 'Europe/London').toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('follows daylight saving', () => {
    expect(zonedTimeToUtc('2026-07-15', '09:00', 'Europe/London').toISOString()).toBe('2026-07-15T08:00:00.000Z');
  });
});

describe('localDate', () => {
  it('gives the calendar date in the zone', () => {
    expect(localDate(new Date('2026-11-06T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-07');
    expect(localDate(new Date('2026-11-06T20:00:00Z'), 'Europe/London')).toBe('2026-11-06');
  });
});

describe('nextFreeSlots', () => {
  it('starts today when the time is still ahead', () => {
    const now = new Date('2026-11-06T08:00:00Z'); // 13:30 IST
    expect(nextFreeSlots(IST, [], now, 2).map((d) => d.toISOString())).toEqual(['2026-11-06T13:30:00.000Z', '2026-11-07T13:30:00.000Z']);
  });

  it('starts tomorrow when today’s time has passed', () => {
    const now = new Date('2026-11-06T14:00:00Z'); // 19:30 IST
    expect(nextFreeSlots(IST, [], now, 1)[0].toISOString()).toBe('2026-11-07T13:30:00.000Z');
  });

  it('skips days that already have a post (one a day)', () => {
    const now = new Date('2026-11-06T08:00:00Z');
    const taken = ['2026-11-06T05:00:00Z', '2026-11-07T13:30:00.000Z'];
    expect(nextFreeSlots(IST, taken, now, 2).map((d) => d.toISOString())).toEqual(['2026-11-08T13:30:00.000Z', '2026-11-09T13:30:00.000Z']);
  });

  it('fills every daily time before moving to the next day, earliest first', () => {
    const now = new Date('2026-11-06T02:00:00Z'); // 07:30 IST
    expect(nextFreeSlots(TWICE, [], now, 3).map((d) => d.toISOString())).toEqual([
      '2026-11-06T03:30:00.000Z',
      '2026-11-06T13:30:00.000Z',
      '2026-11-07T03:30:00.000Z',
    ]);
  });

  it('skips a time already taken and keeps the other one free', () => {
    const now = new Date('2026-11-06T02:00:00Z');
    const taken = ['2026-11-06T03:30:00.000Z'];
    expect(nextFreeSlots(TWICE, taken, now, 1)[0].toISOString()).toBe('2026-11-06T13:30:00.000Z');
  });

  it('counts a post at an odd hour against its day', () => {
    const now = new Date('2026-11-06T02:00:00Z');
    const taken = ['2026-11-06T09:47:00.000Z']; // 15:17 IST, by hand
    expect(nextFreeSlots(TWICE, taken, now, 2).map((d) => d.toISOString())).toEqual([
      '2026-11-06T03:30:00.000Z',
      '2026-11-07T03:30:00.000Z',
    ]);
  });

  it('never offers a slot less than five minutes away', () => {
    const now = new Date('2026-11-06T13:27:00Z'); // 18:57 IST
    expect(nextFreeSlots(IST, [], now, 1)[0].toISOString()).toBe('2026-11-07T13:30:00.000Z');
  });
});
