pub struct ActivityEvent {
    pub count: u64,
}

pub fn hash_event(event: ActivityEvent) -> u64 {
    event.count
}

pub fn track_event(event: ActivityEvent) -> u64 {
    hash_event(event)
}
