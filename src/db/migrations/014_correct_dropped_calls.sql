-- Correct imported test calls whose metadata explicitly declares that the call dropped.
UPDATE call_recordings
SET title='Call Dropped',
    issue_summary='Call dropped',
    resolution_status='DROPPED',
    call_statuses=array_append(
      array_remove(array_remove(array_remove(call_statuses,'RESOLVED'),'UNSOLVED'),'DROPPED'),
      'DROPPED'
    ),
    analysis_prompt_version='v2',
    updated_at=now()
WHERE raw_metadata #>> '{additional_data,expected_resolution_status}' = 'DROPPED';
