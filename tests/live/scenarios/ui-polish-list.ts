import type { LiveScenario } from '../scenarios.ts'

export const scenario: LiveScenario = {
  id: 'ui-polish-list',
  tier: 'core',
  kind: 'ui',
  ambiguity: 'clarify-or-state',
  issue: {
    title: 'task 목록 화면을 좀 더 보기 좋게 해 주세요',
    body: '@{{agent}} 웹 앱의 task 목록 화면이 밋밋하고 한눈에 잘 안 들어옵니다. 좀 더 보기 좋게 다듬어 주세요. 저장소 루트에서 npm run typecheck와 npm test가 통과하도록 하고 pull request를 열어 주세요.',
  },
  answer:
    '@{{agent}} 목록의 각 행이 서로 잘 구분되고 상태와 마감일이 한눈에 읽히도록 다듬어 주시면 됩니다. 기존 동작은 그대로 두고, 무엇을 어떻게 바꿨는지 pull request 본문에 적어 주세요.',
  diff: { requireSourceAndTest: false, requireSource: true, allowedRoots: ['web/'], allowLockfile: false },
}
