-- Keep every existing dropped call aligned with the display contract used for new analyses.
UPDATE call_recordings
SET title='Call Dropped',
    issue_summary='Call dropped',
    call_statuses=array_append(
      array_remove(array_remove(array_remove(call_statuses,'RESOLVED'),'UNSOLVED'),'DROPPED'),
      'DROPPED'
    ),
    updated_at=now()
WHERE resolution_status='DROPPED';
