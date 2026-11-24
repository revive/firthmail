//! An aligned-block cache in front of a `Read + Seek` source.
//!
//! A PST/OST is a B-tree file: walking it means many small reads at scattered
//! offsets, and the same pages (the B-tree roots and upper levels, a folder's
//! table) are read again and again. On a local disk the operating system's
//! cache absorbs that; a userspace cache on top still cuts syscall noise and
//! keeps working when the file sits on a network share.
//!
//! Adapted from pst-markdown's `cache.rs`
//! (MIT OR Apache-2.0, https://github.com/lwm-luminx/markdown-extract).

use std::cell::Cell;
use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::rc::Rc;

/// What the cache asked of the source, for tuning and reporting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IoStats {
    /// Blocks read from the source.
    pub reads: u64,
    /// Bytes read from the source.
    pub bytes: u64,
    /// Seeks sent to the source (a read that continues where the last ended needs none).
    pub seeks: u64,
    /// Reads served from the cache.
    pub hits: u64,
}

pub struct CachedReader<R> {
    inner: R,
    /// Where `inner` is positioned, when known.
    inner_pos: Option<u64>,
    len: u64,
    pos: u64,
    block_size: u64,
    capacity: usize,
    blocks: HashMap<u64, (Vec<u8>, u64)>,
    clock: u64,
    stats: Rc<Cell<IoStats>>,
}

impl<R: Read + Seek> CachedReader<R> {
    pub fn new(mut inner: R, block_size: usize, capacity: usize) -> io::Result<Self> {
        let len = inner.seek(SeekFrom::End(0))?;
        let stats = IoStats {
            seeks: 1,
            ..IoStats::default()
        };
        Ok(CachedReader {
            inner,
            inner_pos: Some(len),
            len,
            pos: 0,
            block_size: block_size.max(4096) as u64,
            capacity: capacity.max(2),
            blocks: HashMap::new(),
            clock: 0,
            stats: Rc::new(Cell::new(stats)),
        })
    }

    pub fn stats(&self) -> Rc<Cell<IoStats>> {
        self.stats.clone()
    }

    fn update(&self, f: impl FnOnce(&mut IoStats)) {
        let mut stats = self.stats.get();
        f(&mut stats);
        self.stats.set(stats);
    }

    /// The block holding offset `index * block_size`, read if need be.
    fn block(&mut self, index: u64) -> io::Result<&[u8]> {
        self.clock += 1;
        let clock = self.clock;
        if self.blocks.contains_key(&index) {
            self.update(|s| s.hits += 1);
            let entry = self.blocks.get_mut(&index).expect("present");
            entry.1 = clock;
            return Ok(&entry.0);
        }
        if self.blocks.len() >= self.capacity
            && let Some(oldest) = self
                .blocks
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(k, _)| *k)
        {
            self.blocks.remove(&oldest);
        }
        let start = index * self.block_size;
        let size = self.block_size.min(self.len.saturating_sub(start)) as usize;
        if self.inner_pos != Some(start) {
            self.inner_pos = None;
            self.inner.seek(SeekFrom::Start(start))?;
            self.update(|s| s.seeks += 1);
        }
        let mut data = vec![0; size];
        self.inner.read_exact(&mut data)?;
        self.inner_pos = Some(start + size as u64);
        self.update(|s| {
            s.reads += 1;
            s.bytes += size as u64;
        });
        Ok(&self.blocks.entry(index).or_insert((data, clock)).0)
    }
}

impl<R: Read + Seek> Read for CachedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        let block_size = self.block_size;
        let index = self.pos / block_size;
        let offset = (self.pos % block_size) as usize;
        let block = self.block(index)?;
        let n = (block.len() - offset).min(buf.len());
        buf[..n].copy_from_slice(&block[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl<R: Read + Seek> Seek for CachedReader<R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        self.pos = target
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before start"))?;
        Ok(self.pos)
    }
}
