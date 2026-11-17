// THROWAWAY (#1174): fails on purpose, to see the E2E workflow's failure path (the scrub, the secret check and the artifact upload) in CI.
// This file and the commit that adds it are reverted in the next commit.
describe('zz: failure path check', () => {
  it('fails on purpose', () => {
    cy.visit('/');
    cy.get('#this-element-does-not-exist', { timeout: 2000 });
  });
});
