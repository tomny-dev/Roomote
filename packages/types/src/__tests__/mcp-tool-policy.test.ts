import {
  filterMcpToolDefinitions,
  getAllowedIntegrationMcpToolNames,
  isMcpToolAllowed,
} from '../mcp-tool-policy';

describe('monday.com MCP tool policy', () => {
  it('allows documented inspection tools and excludes mutating escape hatches', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames('monday');

    expect(allowedToolNames).toEqual(
      expect.arrayContaining([
        'get_board_info',
        'get_board_items_page',
        'get_updates',
        'read_docs',
        'search',
      ]),
    );
    expect(allowedToolNames).not.toContain('create_item');
    expect(allowedToolNames).not.toContain('change_item_column_values');
    expect(allowedToolNames).not.toContain('all_monday_api');
  });
});

describe('Jira MCP v2 proxy tool policy', () => {
  it('exposes Jira issue reads and the authorized non-destructive issue writes', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames('jira');
    expect(allowedToolNames).toEqual(
      expect.arrayContaining([
        'getJiraIssue',
        'searchJiraIssuesUsingJql',
        'listJiraIssueTransitions',
        'listJiraIssueComments',
        'createJiraIssue',
        'editJiraIssue',
        'transitionJiraIssue',
        'addOrEditJiraIssueComment',
      ]),
    );

    for (const unsafe of [
      'deleteJiraIssue',
      'deleteJiraComment',
      'createJiraProject',
      'updateJiraProject',
      'executeWrite',
      'executeDestructive',
      'createConfluenceContent',
    ]) {
      expect(allowedToolNames).not.toContain(unsafe);
    }
  });

  it('filters discovery and execution with the same policy, including admin-disabled tools', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames('jira');
    const policy = {
      allowedToolNames,
      disabledToolNames: ['transitionJiraIssue'],
    };
    const catalog = [
      { name: 'getJiraIssue' },
      { name: 'createJiraIssue' },
      { name: 'transitionJiraIssue' },
      { name: 'deleteJiraIssue' },
      { name: 'executeWrite' },
    ];

    expect(filterMcpToolDefinitions(catalog, policy)).toEqual([
      { name: 'getJiraIssue' },
      { name: 'createJiraIssue' },
    ]);
    expect(isMcpToolAllowed('createJiraIssue', policy)).toBe(true);
    expect(isMcpToolAllowed('transitionJiraIssue', policy)).toBe(false);
    expect(isMcpToolAllowed('deleteJiraIssue', policy)).toBe(false);
  });
});
