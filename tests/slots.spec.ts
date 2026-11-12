/**
 * Worker slot accounting: normal slots, the extra slot for a person, and waiting wakes that take a freed slot
 * before a launch.
 */
import { expect, it } from 'vitest'
import { Slots } from '../src/executor/slots.ts'

it('allows max launches and refuses the next', () => {
  const slots = new Slots(2)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  expect(slots.acquire('b', 'launch', false)).toBe(true)
  expect(slots.acquire('c', 'launch', false)).toBe(false)
  expect(slots.used).toBe(2)
})

it('takes one slot per ticket however often it acquires', () => {
  const slots = new Slots(2)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  expect(slots.acquire('a', 'wake', true)).toBe(true)
  expect(slots.used).toBe(1)
})

it('gives a person one extra slot while the normal slots are full', () => {
  const slots = new Slots(2)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  expect(slots.acquire('b', 'launch', false)).toBe(true)
  expect(slots.acquire('h1', 'wake', true)).toBe(true)
  expect(slots.acquire('h2', 'wake', true)).toBe(false)
  expect(slots.acquire('w', 'wake', false)).toBe(false)
  expect(slots.used).toBe(3)
})

it('does not let a launch or a wake for no person use the extra slot', () => {
  const slots = new Slots(1)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  expect(slots.acquire('b', 'launch', true)).toBe(false)
  expect(slots.acquire('c', 'wake', false)).toBe(false)
})

it('releases idempotently', () => {
  const slots = new Slots(2)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  slots.release('a')
  slots.release('a')
  expect(() => slots.release('never')).not.toThrow()
  expect(slots.used).toBe(0)
  expect(slots.launchRoom()).toBe(2)
})

it('lets a waiting wake take a freed slot before a launch', () => {
  const slots = new Slots(1)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  expect(slots.acquire('b', 'wake', false)).toBe(false)
  slots.release('a')
  expect(slots.acquire('c', 'launch', false)).toBe(false)
  expect(slots.acquire('b', 'wake', false)).toBe(true)
  slots.release('b')
  expect(slots.acquire('c', 'launch', false)).toBe(true)
})

it('forgets a waiting wake on release', () => {
  const slots = new Slots(1)
  expect(slots.acquire('a', 'launch', false)).toBe(true)
  expect(slots.acquire('b', 'wake', false)).toBe(false)
  slots.release('b')
  slots.release('a')
  expect(slots.acquire('c', 'launch', false)).toBe(true)
})
