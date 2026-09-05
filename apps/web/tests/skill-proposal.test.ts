import { describe, expect, it } from 'vitest'

import {
  SKILL_PROPOSAL_CLOSE,
  SKILL_PROPOSAL_OPEN,
  foldSkillProposalForDisplay,
} from '../src/skillProposal'

describe('foldSkillProposalForDisplay', () => {
  it('leaves ordinary text untouched', () => {
    expect(foldSkillProposalForDisplay('just a normal reply')).toBe('just a normal reply')
    expect(foldSkillProposalForDisplay('')).toBe('')
  })

  it('folds a complete proposal block to a placeholder', () => {
    const text = `Here you go:\n\n${SKILL_PROPOSAL_OPEN}\nname: X\ndescription: y\n---\nbody\n${SKILL_PROPOSAL_CLOSE}`
    const out = foldSkillProposalForDisplay(text)
    expect(out).not.toContain(SKILL_PROPOSAL_OPEN)
    expect(out).not.toContain('name: X')
    expect(out).toContain('Here you go:')
    expect(out).toContain('Creating ClawHunt skill')
  })

  it('folds an in-progress (unclosed) block while streaming', () => {
    // Mid-stream: open tag arrived, close tag not yet.
    const text = `Sure:\n\n${SKILL_PROPOSAL_OPEN}\nname: Partial\ndescription: still`
    const out = foldSkillProposalForDisplay(text)
    expect(out).not.toContain(SKILL_PROPOSAL_OPEN)
    expect(out).not.toContain('name: Partial')
    expect(out).toContain('Sure:')
    expect(out).toContain('Creating ClawHunt skill')
  })

  it('folds every block when more than one is present', () => {
    const text =
      `a ${SKILL_PROPOSAL_OPEN}\nname: X\n---\nb1\n${SKILL_PROPOSAL_CLOSE} mid ` +
      `${SKILL_PROPOSAL_OPEN}\nname: Y\n---\nb2\n${SKILL_PROPOSAL_CLOSE} end`
    const out = foldSkillProposalForDisplay(text)
    expect(out).not.toContain(SKILL_PROPOSAL_OPEN)
    expect(out).not.toContain('name: X')
    expect(out).not.toContain('name: Y')
    expect(out).toContain('mid')
    expect(out).toContain('end')
  })

  it('is idempotent on already-folded text', () => {
    const once = foldSkillProposalForDisplay(`x ${SKILL_PROPOSAL_OPEN}\nname: X\n---\nb\n${SKILL_PROPOSAL_CLOSE}`)
    expect(foldSkillProposalForDisplay(once)).toBe(once)
  })

  it('keeps text after the block', () => {
    const text = `${SKILL_PROPOSAL_OPEN}\nname: X\ndescription: y\n---\nbody\n${SKILL_PROPOSAL_CLOSE}\n\nDone.`
    const out = foldSkillProposalForDisplay(text)
    expect(out).toContain('Creating ClawHunt skill')
    expect(out).toContain('Done.')
    expect(out).not.toContain(SKILL_PROPOSAL_OPEN)
  })
})
